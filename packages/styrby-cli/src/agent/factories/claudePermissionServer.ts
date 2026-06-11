/**
 * Claude Permission Server — in-process MCP host for per-tool approval
 *
 * Backs interactive per-tool mobile approval for the managed `claude` backend.
 *
 * ## Why this exists
 *
 * The `claude` binary, run headless with `--permission-mode default`, routes
 * every gated tool-use decision to a single MCP tool named by
 * `--permission-prompt-tool`. That tool receives `{ tool_name, input }` and must
 * return `{ behavior: 'allow', updatedInput } | { behavior: 'deny', message }`.
 * Claude blocks the tool until the prompt tool resolves. This is the same
 * pause-and-ask shape Codex gets from its MCP elicitation handler.
 *
 * We host that prompt tool ourselves, **in-process**, so its handler can call
 * straight back into the {@link import('./claude').ClaudeBackend} — emitting a
 * `permission-request` AgentMessage and awaiting the relayed mobile decision —
 * rather than going through a separate process or the Supabase round-trip. That
 * keeps claude's approvals on the exact same inline relay + PermissionCard path
 * every other agent uses.
 *
 * ## Why HTTP transport (not stdio)
 *
 * `--mcp-config` can register a server by either spawning a command (stdio) or
 * connecting to a URL (http/sse). Stdio would run our tool handler in a child
 * process with no access to the ClaudeBackend instance. An in-process HTTP
 * server on localhost keeps the handler in the SAME process, so it can resolve
 * the parked approval promise directly. The server binds to 127.0.0.1 on an
 * ephemeral port (loopback only — never reachable off-box).
 *
 * @module factories/claudePermissionServer
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@/ui/logger';

/**
 * The MCP server name. Combined with the tool name to form the fully-qualified
 * `--permission-prompt-tool` identifier claude expects: `mcp__<server>__<tool>`.
 */
export const PERMISSION_MCP_SERVER_NAME = 'styrby';

/** The prompt tool's bare name. */
export const PERMISSION_TOOL_NAME = 'permission_prompt';

/**
 * The fully-qualified tool id passed to `--permission-prompt-tool`.
 * Format is claude's MCP tool convention: `mcp__<serverName>__<toolName>`.
 */
export const PERMISSION_PROMPT_TOOL_ID = `mcp__${PERMISSION_MCP_SERVER_NAME}__${PERMISSION_TOOL_NAME}`;

/**
 * A permission decision returned to claude for one gated tool-use.
 *
 * @property approved - true => claude runs the tool; false => claude skips it.
 * @property updatedInput - Optional replacement tool input on approve. When
 *   omitted the original input is echoed back unchanged (claude requires the
 *   allow response to carry the input it should run with).
 * @property message - Optional human-readable reason surfaced to claude on deny.
 */
export interface PermissionDecision {
  approved: boolean;
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/**
 * Decide whether claude may use a tool. Implemented by ClaudeBackend: it emits a
 * `permission-request`, parks a promise, and resolves it from the relayed mobile
 * response (see `respondToPermission`).
 *
 * @param toolName - The claude tool claude wants to run (e.g. 'Bash', 'Edit').
 * @param input - The tool's input arguments.
 * @param toolUseId - Claude's tool_use id, when provided. Used as the stable
 *   correlation id for the permission round-trip.
 * @returns The user's decision once it arrives (or a deny on timeout/teardown).
 */
export type PermissionDecider = (
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
) => Promise<PermissionDecision>;

/**
 * A running permission server. Returned by {@link startClaudePermissionServer}.
 *
 * @property url - The MCP endpoint URL to register in `--mcp-config`.
 * @property close - Tears down the HTTP server + all live MCP transports.
 */
export interface RunningPermissionServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Input schema for the permission-prompt tool.
 *
 * Claude invokes the prompt tool with the tool it wants to run plus that tool's
 * arguments. `tool_use_id` is the correlation handle; `permission_suggestions`
 * is advisory metadata claude may attach (ignored here — the human decides).
 */
const PERMISSION_TOOL_INPUT = {
  tool_name: z.string(),
  input: z.record(z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  permission_suggestions: z.unknown().optional(),
};

/**
 * Build the MCP server that hosts the permission-prompt tool.
 *
 * The tool handler delegates the decision to `decide` and formats the result in
 * claude's required `{ behavior }` envelope. Per the claude permission-prompt
 * contract, the JSON payload is returned as a text content block.
 *
 * @param decide - The decision callback (ClaudeBackend's relay round-trip).
 * @returns An unconnected McpServer.
 */
function buildPermissionMcpServer(decide: PermissionDecider): McpServer {
  const server = new McpServer({ name: 'styrby-claude-permission', version: '1.0.0' });

  server.registerTool(
    PERMISSION_TOOL_NAME,
    {
      title: 'Styrby mobile permission prompt',
      description:
        'Claude permission-prompt-tool hook. Forwards the pending tool-use to the ' +
        'paired mobile device for an inline approve/deny decision.',
      inputSchema: PERMISSION_TOOL_INPUT,
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const toolName = args.tool_name;
      const input = (args.input as Record<string, unknown>) ?? {};
      const toolUseId = args.tool_use_id;

      let decision: PermissionDecision;
      try {
        decision = await decide(toolName, input, toolUseId);
      } catch (err) {
        // WHY deny on error: failing closed is the safe default for a permission
        // gate. A decider that throws (teardown mid-flight, relay failure) must
        // never be read by claude as an implicit allow.
        logger.debug('[ClaudePermissionServer] decider threw — denying', err);
        decision = { approved: false, message: 'Approval unavailable' };
      }

      // WHY this envelope shape: claude's --permission-prompt-tool contract reads
      // the FIRST text content block as JSON. allow must echo the input claude
      // should run with (updatedInput); deny carries an optional message.
      const behavior = decision.approved
        ? { behavior: 'allow' as const, updatedInput: decision.updatedInput ?? input }
        : { behavior: 'deny' as const, message: decision.message ?? 'Denied on mobile' };

      return { content: [{ type: 'text', text: JSON.stringify(behavior) }] };
    },
  );

  return server;
}

/**
 * Start the in-process permission MCP server on a loopback ephemeral port.
 *
 * The server speaks MCP over Streamable HTTP. Each MCP session (claude opens one)
 * gets its own {@link StreamableHTTPServerTransport}, tracked by session id so
 * follow-up GET (SSE) / DELETE requests route to the right transport.
 *
 * @param decide - The decision callback invoked for every gated tool-use.
 * @returns The endpoint URL + a `close()` teardown.
 *
 * @example
 * const srv = await startClaudePermissionServer((tool, input, id) => askMobile(tool, input, id));
 * // register srv.url in --mcp-config, then `--permission-prompt-tool` = PERMISSION_PROMPT_TOOL_ID
 * await srv.close();
 */
export async function startClaudePermissionServer(
  decide: PermissionDecider,
): Promise<RunningPermissionServer> {
  // One McpServer instance; a transport per MCP session (claude opens exactly one
  // for the lifetime of a prompt run, but we support N defensively).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Capability-URL token (SEC-CLAUDEPERM-001): the endpoint path embeds an
  // unguessable 256-bit token. claude connects to the full URL verbatim from its
  // --mcp-config (which we write 0600), so the token rides along automatically —
  // no header support needed. Any OTHER local process that reaches the loopback
  // port but can't read the 0600 config file hits a path it can't guess and gets
  // a 404, so it can neither call the permission tool (notification-spam /
  // approver-phishing) nor learn what tools claude is running. Defense-in-depth
  // atop loopback-only binding + ephemeral port + transient lifetime.
  const capabilityToken = randomBytes(32).toString('hex');
  const basePath = `/mcp/${capabilityToken}`;

  /** Read and JSON-parse a request body (POST carries the JSON-RPC message). */
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (chunks.length === 0) return resolve(undefined);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', () => resolve(undefined));
    });

  const httpServer: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // Capability check: reject any path that doesn't present the token.
        // Constant-ish prefix check; the token is high-entropy so a timing side
        // channel on the prefix compare is not meaningful here.
        const reqPath = (req.url ?? '').split('?')[0];
        if (reqPath !== basePath) {
          res.writeHead(404).end('Not found');
          return;
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const existing = sessionId ? transports.get(sessionId) : undefined;

        // GET (SSE stream) and DELETE (session teardown) route to an existing
        // transport by session id; they carry no body.
        if (req.method === 'GET' || req.method === 'DELETE') {
          if (!existing) {
            res.writeHead(400).end('Unknown MCP session');
            return;
          }
          await existing.handleRequest(req, res);
          return;
        }

        const body = await readBody(req);

        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }

        // No session yet: only an `initialize` request may open one.
        if (isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          const server = buildPermissionMcpServer(decide);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400).end('No valid MCP session');
      } catch (err) {
        logger.debug('[ClaudePermissionServer] request error', err);
        if (!res.headersSent) res.writeHead(500).end('Permission server error');
      }
    })();
  });

  // Bind to loopback only on an ephemeral port. 127.0.0.1 (not 0.0.0.0) so the
  // approval endpoint is never reachable off the host.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    httpServer.close();
    throw new Error('Permission server failed to bind a TCP port');
  }
  const url = `http://127.0.0.1:${addr.port}${basePath}`;
  logger.debug(`[ClaudePermissionServer] listening on 127.0.0.1:${addr.port} (capability path)`);

  return {
    url,
    close: async () => {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          /* best-effort transport teardown */
        }
      }
      transports.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.debug('[ClaudePermissionServer] closed');
    },
  };
}
