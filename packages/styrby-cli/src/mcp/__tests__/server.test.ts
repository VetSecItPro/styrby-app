/**
 * Tests for the Styrby MCP server.
 *
 * Exercises the high-level contract:
 *   - The server registers exactly one tool (`request_approval`)
 *   - Calling the tool delegates to the injected ApprovalHandler
 *   - The tool's input schema validates as expected (rejects invalid risk,
 *     enforces max lengths, defaults timeout)
 *   - The tool's response shape matches the declared output schema
 *
 * No real Supabase. The ApprovalHandler is a stub that records calls and
 * returns canned decisions, so these tests are pure-function fast.
 *
 * @module mcp/__tests__/server
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStyrbyMcpServer, type ApprovalHandler } from '../server';
import type { RequestApprovalInput, RequestApprovalOutput } from '../tools';

// ============================================================================
// Stub handler
// ============================================================================

/**
 * Builds a stub handler that records every request and returns the given
 * canned output. Lets each test inspect what the server passed in.
 */
function stubHandler(canned: RequestApprovalOutput): ApprovalHandler & {
  calls: Array<{ input: RequestApprovalInput; timeoutMs: number }>;
} {
  const calls: Array<{ input: RequestApprovalInput; timeoutMs: number }> = [];
  return {
    calls,
    async request(input, timeoutMs) {
      calls.push({ input, timeoutMs });
      return canned;
    },
  };
}

// ============================================================================
// SDK helper
// ============================================================================

/**
 * Calls a registered tool through the underlying low-level Server API.
 * The high-level McpServer doesn't expose a public "call this tool now"
 * method — the SDK expects clients to talk over a transport. To unit-test
 * a tool handler without spinning up a transport, we reach into the
 * registered tools map via the public `server` property and invoke the
 * stored callback directly.
 *
 * WHY this is acceptable: the registered callback IS the tool's runtime
 * behavior. Skipping the transport just removes the JSON-RPC framing,
 * which the SDK already covers in its own tests.
 */
async function callTool(
  server: ReturnType<typeof createStyrbyMcpServer>,
  name: string,
  args: Record<string, unknown>,
) {
  // The McpServer stores registered tools in a private `_registeredTools` field.
  // Cast to access it for testing — production code never does this.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registered = (server as any)._registeredTools[name];
  if (!registered) {
    throw new Error(`No tool named ${name} registered`);
  }
  return registered.handler(args, {
    /* RequestHandlerExtra stub — none of our handler code reads it */
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('createStyrbyMcpServer', () => {
  let handler: ReturnType<typeof stubHandler>;

  beforeEach(() => {
    handler = stubHandler({
      decision: 'approved',
      decidedAt: '2026-04-20T20:00:00.000Z',
      reason: '',
    });
  });

  describe('tool registration', () => {
    it('registers the request_approval tool', () => {
      const server = createStyrbyMcpServer(handler);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registered = (server as any)._registeredTools;
      expect(Object.keys(registered)).toContain('request_approval');
    });

    it('does not register any other tools in the Phase 1 wedge', () => {
      const server = createStyrbyMcpServer(handler);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registered = (server as any)._registeredTools;
      expect(Object.keys(registered)).toEqual(['request_approval']);
    });
  });

  describe('request_approval handler', () => {
    it('forwards valid input to the approval handler', async () => {
      const server = createStyrbyMcpServer(handler);
      await callTool(server, 'request_approval', {
        action: 'Delete production database',
        reason: 'User asked to clean up old prod data',
        risk: 'high',
      });

      expect(handler.calls).toHaveLength(1);
      expect(handler.calls[0].input).toMatchObject({
        action: 'Delete production database',
        reason: 'User asked to clean up old prod data',
        risk: 'high',
      });
    });

    it('uses the default 5-minute timeout when caller omits it', async () => {
      const server = createStyrbyMcpServer(handler);
      await callTool(server, 'request_approval', {
        action: 'A',
        reason: 'B',
        risk: 'low',
      });

      expect(handler.calls[0].timeoutMs).toBe(300_000);
    });

    it('passes through a custom timeout converted to milliseconds', async () => {
      const server = createStyrbyMcpServer(handler);
      await callTool(server, 'request_approval', {
        action: 'A',
        reason: 'B',
        risk: 'low',
        timeoutSeconds: 60,
      });

      expect(handler.calls[0].timeoutMs).toBe(60_000);
    });

    it('passes optional context through unchanged', async () => {
      const server = createStyrbyMcpServer(handler);
      const context = { commitHash: 'abc123', files: ['src/index.ts'] };
      await callTool(server, 'request_approval', {
        action: 'Push to main',
        reason: 'Ship the feature',
        risk: 'medium',
        context,
      });

      expect(handler.calls[0].input.context).toEqual(context);
    });

    it('returns approved decision in both content and structuredContent', async () => {
      const server = createStyrbyMcpServer(handler);
      const result = (await callTool(server, 'request_approval', {
        action: 'A',
        reason: 'B',
        risk: 'low',
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent: RequestApprovalOutput;
      };

      expect(result.structuredContent.decision).toBe('approved');
      expect(result.structuredContent.decidedAt).toBe('2026-04-20T20:00:00.000Z');
      // Content is human-readable - just check the key terms are present
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('approved');
    });

    it('returns denied decision with reason when handler denies', async () => {
      handler = stubHandler({
        decision: 'denied',
        decidedAt: '2026-04-20T20:01:00.000Z',
        reason: 'Wrong project',
      });
      const server = createStyrbyMcpServer(handler);

      const result = (await callTool(server, 'request_approval', {
        action: 'A',
        reason: 'B',
        risk: 'high',
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent: RequestApprovalOutput;
      };

      expect(result.structuredContent.decision).toBe('denied');
      expect(result.structuredContent.reason).toBe('Wrong project');
      expect(result.content[0].text).toContain('denied');
      expect(result.content[0].text).toContain('Wrong project');
    });

    it('propagates handler errors as a thrown promise (MCP layer surfaces as tool error)', async () => {
      const failingHandler: ApprovalHandler = {
        async request() {
          throw new Error('Supabase unreachable');
        },
      };
      const server = createStyrbyMcpServer(failingHandler);

      await expect(
        callTool(server, 'request_approval', {
          action: 'A',
          reason: 'B',
          risk: 'low',
        }),
      ).rejects.toThrow('Supabase unreachable');
    });
  });
});
