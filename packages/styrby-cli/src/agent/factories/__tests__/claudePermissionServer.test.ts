/**
 * claudePermissionServer test suite.
 *
 * Drives a REAL MCP client (StreamableHTTP) against the in-process permission
 * server to prove the end-to-end contract claude relies on:
 *  - the server advertises exactly one tool (permission_prompt)
 *  - calling it routes (tool_name, input, tool_use_id) to the injected decider
 *  - an approve returns {behavior:'allow', updatedInput}
 *  - a deny returns {behavior:'deny', message}
 *  - a decider that throws fails CLOSED (deny) — never an implicit allow
 *  - close() tears the HTTP server down
 *
 * The tool's text content is the JSON envelope claude's --permission-prompt-tool
 * parses, so asserting it here locks the wire contract.
 *
 * @module factories/__tests__/claudePermissionServer.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  startClaudePermissionServer,
  PERMISSION_PROMPT_TOOL_ID,
  PERMISSION_TOOL_NAME,
  type PermissionDecider,
  type RunningPermissionServer,
} from '../claudePermissionServer';

/** Connect a fresh MCP client to a running permission server. */
async function connect(server: RunningPermissionServer): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  return client;
}

/** Parse the first text content block as the claude permission envelope. */
function envelopeOf(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

async function withServer(
  decide: PermissionDecider,
  run: (client: Client, server: RunningPermissionServer) => Promise<void>,
): Promise<void> {
  const server = await startClaudePermissionServer(decide);
  let client: Client | undefined;
  try {
    client = await connect(server);
    await run(client, server);
  } finally {
    if (client) await client.close();
    await server.close();
  }
}

describe('startClaudePermissionServer', () => {
  it('binds a loopback URL and exposes exactly the permission_prompt tool', async () => {
    await withServer(
      async () => ({ approved: true }),
      async (client, server) => {
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual([PERMISSION_TOOL_NAME]);
      },
    );
  });

  it('exposes the fully-qualified tool id claude expects', () => {
    expect(PERMISSION_PROMPT_TOOL_ID).toBe('mcp__styrby__permission_prompt');
  });

  it('routes (tool_name, input, tool_use_id) to the decider and returns allow', async () => {
    const seen: Array<[string, Record<string, unknown>, string | undefined]> = [];
    const decide: PermissionDecider = async (tool, input, id) => {
      seen.push([tool, input, id]);
      return { approved: true };
    };
    await withServer(decide, async (client) => {
      const result = await client.callTool({
        name: PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-1' },
      });
      // Decider saw the exact tool-use.
      expect(seen).toEqual([['Bash', { command: 'ls' }, 'tu-1']]);
      // allow echoes the input back as updatedInput (claude runs with this).
      expect(envelopeOf(result)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    });
  });

  it('returns deny with the decider message', async () => {
    const decide: PermissionDecider = async () => ({ approved: false, message: 'Denied on mobile' });
    await withServer(decide, async (client) => {
      const result = await client.callTool({
        name: PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Edit', input: { file_path: '/x' }, tool_use_id: 'tu-2' },
      });
      expect(envelopeOf(result)).toEqual({ behavior: 'deny', message: 'Denied on mobile' });
    });
  });

  it('honors a decider-supplied updatedInput on allow', async () => {
    const decide: PermissionDecider = async () => ({ approved: true, updatedInput: { command: 'ls -la' } });
    await withServer(decide, async (client) => {
      const result = await client.callTool({
        name: PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-3' },
      });
      expect(envelopeOf(result)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
    });
  });

  it('FAILS CLOSED (deny) when the decider throws', async () => {
    const decide: PermissionDecider = async () => {
      throw new Error('relay down');
    };
    await withServer(decide, async (client) => {
      const result = await client.callTool({
        name: PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Bash', input: {}, tool_use_id: 'tu-4' },
      });
      expect(envelopeOf(result)).toMatchObject({ behavior: 'deny' });
    });
  });
});
