/**
 * Shared types for the ACP backend.
 *
 * WHY: The official `@agentclientprotocol/sdk` types are intentionally narrow,
 * but real agents (Crush, Gemini CLI, Codex) emit richer payloads with extra
 * fields the SDK doesn't model. We extend the SDK types here so the rest of
 * the backend can talk in well-typed shapes without scattering `as any` casts.
 */

import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '../core';
import type { TransportHandler } from '../transport';

/**
 * Extended `RequestPermissionRequest` with fields some agents add.
 *
 * - `toolCall`: Crush-style nested object describing the call.
 * - `kind` / `input` / `arguments` / `content`: top-level variants used by other agents.
 * - `options`: the choices the agent presents to the user (proceed_once, …).
 */
export type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    id?: string;
    kind?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

/**
 * Extended `SessionNotification` whose `update` payload models the optional
 * fields agents emit (tool_call_update, plan, thinking, …).
 */
export type ExtendedSessionNotification = SessionNotification & {
  update?: {
    sessionUpdate?: string;
    toolCallId?: string;
    status?: string;
    kind?: string | unknown;
    content?:
      | {
          text?: string;
          error?: string | { message?: string };
          [key: string]: unknown;
        }
      | string
      | unknown;
    locations?: unknown[];
    messageChunk?: {
      textDelta?: string;
    };
    plan?: unknown;
    thinking?: unknown;
    [key: string]: unknown;
  };
};

/**
 * Permission-handler interface implemented by callers (mobile dialog, CLI prompt).
 *
 * `handleToolCall` is awaited synchronously inside the ACP `requestPermission`
 * RPC; the returned decision drives which `optionId` we send back to the agent.
 */
export interface AcpPermissionHandler {
  /**
   * Decide whether a tool call should proceed.
   *
   * @param toolCallId - Unique ID of the tool call (also the permission ID).
   * @param toolName   - Resolved tool name (e.g., 'read_file', 'shell').
   * @param input      - Tool input parameters as supplied by the agent.
   * @returns A decision payload; defaults to 'denied' on error.
   */
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<{
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
  }>;
}

/**
 * Configuration for {@link AcpBackend}.
 */
export interface AcpBackendOptions {
  /** Agent name for identification (used by transport handlers + logs). */
  agentName: string;
  /** Working directory the agent subprocess runs in. */
  cwd: string;
  /** Command/binary used to spawn the ACP agent. */
  command: string;
  /** Arguments for the agent command. */
  args?: string[];
  /** Environment variables passed to the agent (merged with safe defaults). */
  env?: Record<string, string>;
  /** MCP servers to make available to the agent. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Optional permission handler for tool approval decisions. */
  permissionHandler?: AcpPermissionHandler;
  /** Transport handler for agent-specific behavior (timeouts, filtering, …). */
  transportHandler?: TransportHandler;
  /** Optional callback to detect a `change_title` instruction in the prompt. */
  hasChangeTitleInstruction?: (prompt: string) => boolean;
}
