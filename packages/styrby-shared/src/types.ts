/**
 * Shared type definitions for Styrby
 */

/** Agent identifiers supported by Styrby */
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider';

/** Session status */
export type SessionStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'error';

/** Connection status for CLI ↔ Mobile relay */
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

/** Error source classification for smart error attribution */
export type ErrorSource =
  | 'styrby'      // Styrby infrastructure issue
  | 'agent'       // Agent error (Claude Code, Codex, Gemini)
  | 'api'         // Provider API error (Anthropic, OpenAI, Google)
  | 'network'     // Network connectivity issue
  | 'build'       // Build tool error (npm, tsc, eslint, etc)
  | 'permission'; // Permission denied error

/** Risk level for permission requests */
export type RiskLevel = 'low' | 'medium' | 'high';

/** Permission request from agent */
export interface PermissionRequest {
  id: string;
  agentType: AgentType;
  action: string;
  description: string;
  riskLevel: RiskLevel;
  payload: unknown;
  createdAt: string;
}

/** Cost data for a session */
export interface SessionCost {
  sessionId: string;
  agentType: AgentType;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalCostUsd: number;
  model: string;
}

/** User subscription tier */
export type SubscriptionTier = 'free' | 'pro' | 'power' | 'team';
