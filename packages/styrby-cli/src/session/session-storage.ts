/**
 * Session Storage
 *
 * Handles persistence of agent sessions to Supabase:
 * - Creates session records with metadata
 * - Stores encrypted messages
 * - Updates session status and costs
 * - Supports session listing and search
 *
 * ## Data Flow
 *
 * ```
 * AgentSession                    SessionStorage                    Supabase
 *     │                                 │                               │
 *     │─── start() ─────────────────────▶ createSession() ─────────────▶│ INSERT sessions
 *     │                                 │                               │
 *     │─── sendToAgent(input) ──────────▶ storeMessage('user') ────────▶│ INSERT session_messages
 *     │                                 │                               │
 *     │◀── output event ────────────────│                               │
 *     │─────────────────────────────────▶ storeMessage('agent') ───────▶│ INSERT session_messages
 *     │                                 │                               │
 *     │─── stop() ──────────────────────▶ endSession() ────────────────▶│ UPDATE sessions
 *     │                                 │                               │
 * ```
 *
 * @module session/session-storage
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import type { AgentType } from '@/auth/agent-credentials';
import { encryptMessage, decryptMessage, deriveSessionKey, type EncryptedPayload, type KeyContext } from './encryption';

// ============================================================================
// Types
// ============================================================================

/**
 * Session status enum (matches database session_status type).
 */
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'paused'
  | 'stopped'
  | 'error'
  | 'expired';

/**
 * Message type enum (matches database message_type type).
 */
export type MessageType =
  | 'user_prompt'
  | 'agent_response'
  | 'agent_thinking'
  | 'permission_request'
  | 'permission_response'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'system';

/**
 * Risk level for permission requests.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * Session record as stored in database.
 */
export interface SessionRecord {
  id: string;
  user_id: string;
  machine_id: string;
  agent_type: AgentType;
  model?: string;
  title?: string;
  summary?: string;
  project_path?: string;
  git_branch?: string;
  git_remote_url?: string;
  tags: string[];
  is_archived: boolean;
  status: SessionStatus;
  error_code?: string;
  error_message?: string;
  started_at: string;
  ended_at?: string;
  last_activity_at: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_tokens: number;
  message_count: number;
  context_window_used?: number;
  context_window_limit?: number;
  created_at: string;
  updated_at: string;
}

/**
 * Data for creating a new session.
 */
export interface CreateSessionData {
  userId: string;
  machineId: string;
  agentType: AgentType;
  model?: string;
  title?: string;
  projectPath?: string;
  gitBranch?: string;
  gitRemoteUrl?: string;
  tags?: string[];
}

/**
 * Data for updating a session.
 */
export interface UpdateSessionData {
  status?: SessionStatus;
  title?: string;
  summary?: string;
  model?: string;
  tags?: string[];
  errorCode?: string;
  errorMessage?: string;
  contextWindowUsed?: number;
  contextWindowLimit?: number;
}

/**
 * Message record as stored in database.
 */
export interface MessageRecord {
  id: string;
  session_id: string;
  sequence_number: number;
  parent_message_id?: string;
  message_type: MessageType;
  content_encrypted?: string;
  encryption_nonce?: string;
  risk_level?: RiskLevel;
  permission_granted?: boolean;
  tool_name?: string;
  duration_ms?: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Data for storing a message.
 */
export interface StoreMessageData {
  sessionId: string;
  messageType: MessageType;
  content: string;
  parentMessageId?: string;
  riskLevel?: RiskLevel;
  permissionGranted?: boolean;
  toolName?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Session list item (subset of fields for display).
 */
export interface SessionListItem {
  id: string;
  agentType: AgentType;
  model?: string;
  title?: string;
  status: SessionStatus;
  startedAt: Date;
  endedAt?: Date;
  totalCostUsd: number;
  messageCount: number;
  lastActivityAt: Date;
  durationMs: number;
}

/**
 * Session storage configuration.
 */
export interface SessionStorageConfig {
  /** Supabase client */
  supabase: SupabaseClient;
  /** User's encryption secret for E2E encryption */
  userSecret: Uint8Array;
  /** Enable debug logging */
  debug?: boolean;
}

// ============================================================================
// Session Storage Class
// ============================================================================

/**
 * Manages session persistence to Supabase.
 *
 * Handles encryption of message content, session lifecycle,
 * and provides query methods for session history.
 */
export class SessionStorage {
  private supabase: SupabaseClient;
  private userSecret: Uint8Array;
  private debug: boolean;

  /** Cache of sequence numbers per session */
  private sequenceCounters: Map<string, number> = new Map();

  /**
   * Cache of derived encryption keys per session.
   * WHY: Keys are expensive to derive; caching improves performance.
   */
  private keyCache: Map<string, Uint8Array> = new Map();

  /**
   * Maximum number of keys to keep in cache.
   * WHY: Prevents unbounded memory growth in long-running CLI processes.
   */
  private readonly MAX_KEY_CACHE_SIZE = 100;

  constructor(config: SessionStorageConfig) {
    this.supabase = config.supabase;
    this.userSecret = config.userSecret;
    this.debug = config.debug ?? false;
  }

  /**
   * Prunes the key cache when it exceeds the maximum size.
   * Uses FIFO eviction (oldest entries first based on insertion order).
   * WHY: Prevents memory growth in long-running CLI processes handling many sessions.
   */
  private pruneKeyCache(): void {
    if (this.keyCache.size > this.MAX_KEY_CACHE_SIZE) {
      const entriesToDelete = this.keyCache.size - this.MAX_KEY_CACHE_SIZE + 10; // Remove 10 extra for headroom
      const keysToDelete = Array.from(this.keyCache.keys()).slice(0, entriesToDelete);
      for (const key of keysToDelete) {
        this.keyCache.delete(key);
      }
      this.log('Pruned key cache', { removed: keysToDelete.length, remaining: this.keyCache.size });
    }
  }

  // --------------------------------------------------------------------------
  // Session Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Create a new session record.
   *
   * Inserts a session with 'starting' status. Call updateSession()
   * to transition to 'running' once the agent is ready.
   *
   * @param data - Session creation data
   * @returns Created session record
   * @throws {Error} If insert fails
   *
   * @example
   * const session = await storage.createSession({
   *   userId: 'user-uuid',
   *   machineId: 'machine-uuid',
   *   agentType: 'claude',
   *   model: 'claude-sonnet-4',
   *   projectPath: '/path/to/project',
   * });
   */
  async createSession(data: CreateSessionData): Promise<SessionRecord> {
    this.log('Creating session', { agentType: data.agentType, projectPath: data.projectPath });

    const { data: session, error } = await this.supabase
      .from('sessions')
      .insert({
        user_id: data.userId,
        machine_id: data.machineId,
        agent_type: data.agentType,
        model: data.model,
        title: data.title,
        project_path: data.projectPath,
        git_branch: data.gitBranch,
        git_remote_url: data.gitRemoteUrl,
        tags: data.tags ?? [],
        status: 'starting' as SessionStatus,
      })
      .select()
      .single();

    if (error) {
      this.log('Failed to create session', { error: error.message });
      throw new Error(`Failed to create session: ${error.message}`);
    }

    this.log('Session created', { sessionId: session.id });
    return session as SessionRecord;
  }

  /**
   * Update a session record.
   *
   * Updates session fields and automatically sets last_activity_at.
   * Use this for status transitions, summary updates, etc.
   *
   * @param sessionId - Session to update
   * @param data - Fields to update
   * @returns Updated session record
   * @throws {Error} If update fails
   *
   * @example
   * await storage.updateSession(sessionId, {
   *   status: 'running',
   *   title: 'Refactoring auth module',
   * });
   */
  async updateSession(sessionId: string, data: UpdateSessionData): Promise<SessionRecord> {
    this.log('Updating session', { sessionId, updates: Object.keys(data) });

    const updatePayload: Record<string, unknown> = {
      last_activity_at: new Date().toISOString(),
    };

    if (data.status !== undefined) updatePayload.status = data.status;
    if (data.title !== undefined) updatePayload.title = data.title;
    if (data.summary !== undefined) updatePayload.summary = data.summary;
    if (data.model !== undefined) updatePayload.model = data.model;
    if (data.tags !== undefined) updatePayload.tags = data.tags;
    if (data.errorCode !== undefined) updatePayload.error_code = data.errorCode;
    if (data.errorMessage !== undefined) updatePayload.error_message = data.errorMessage;
    if (data.contextWindowUsed !== undefined) updatePayload.context_window_used = data.contextWindowUsed;
    if (data.contextWindowLimit !== undefined) updatePayload.context_window_limit = data.contextWindowLimit;

    const { data: session, error } = await this.supabase
      .from('sessions')
      .update(updatePayload)
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      this.log('Failed to update session', { sessionId, error: error.message });
      throw new Error(`Failed to update session: ${error.message}`);
    }

    return session as SessionRecord;
  }

  /**
   * End a session.
   *
   * Sets the session status to 'stopped' and records the end time.
   * Should be called when the agent process exits cleanly.
   *
   * @param sessionId - Session to end
   * @param summary - Optional AI-generated session summary
   * @returns Updated session record
   * @throws {Error} If update fails
   *
   * @example
   * await storage.endSession(sessionId, 'Refactored 3 files, added unit tests');
   */
  async endSession(sessionId: string, summary?: string): Promise<SessionRecord> {
    this.log('Ending session', { sessionId });

    const updatePayload: Record<string, unknown> = {
      status: 'stopped' as SessionStatus,
      ended_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
    };

    if (summary) {
      updatePayload.summary = summary;
    }

    const { data: session, error } = await this.supabase
      .from('sessions')
      .update(updatePayload)
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      this.log('Failed to end session', { sessionId, error: error.message });
      throw new Error(`Failed to end session: ${error.message}`);
    }

    // Clean up cached state
    this.sequenceCounters.delete(sessionId);
    this.keyCache.delete(sessionId);

    this.log('Session ended', { sessionId, status: session.status });
    return session as SessionRecord;
  }

  /**
   * Mark a session as errored.
   *
   * Sets status to 'error' and records error details.
   * Use when the agent process exits with an error.
   *
   * @param sessionId - Session that errored
   * @param errorCode - Error code for categorization
   * @param errorMessage - Human-readable error message
   * @returns Updated session record
   */
  async errorSession(
    sessionId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<SessionRecord> {
    this.log('Marking session as errored', { sessionId, errorCode });

    const { data: session, error } = await this.supabase
      .from('sessions')
      .update({
        status: 'error' as SessionStatus,
        error_code: errorCode,
        error_message: errorMessage,
        ended_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to mark session as errored: ${error.message}`);
    }

    // Clean up cached state
    this.sequenceCounters.delete(sessionId);
    this.keyCache.delete(sessionId);

    return session as SessionRecord;
  }

  // --------------------------------------------------------------------------
  // Message Storage
  // --------------------------------------------------------------------------

  /**
   * Store a message in the session.
   *
   * Encrypts the message content before storage. Messages are
   * automatically sequenced within the session.
   *
   * @param data - Message data to store
   * @param machineId - Machine ID for encryption key derivation
   * @returns Created message record
   * @throws {Error} If storage fails
   *
   * @example
   * // Store user prompt
   * await storage.storeMessage({
   *   sessionId,
   *   messageType: 'user_prompt',
   *   content: 'Please refactor this function',
   * }, machineId);
   *
   * // Store agent response with token counts
   * await storage.storeMessage({
   *   sessionId,
   *   messageType: 'agent_response',
   *   content: agentOutput,
   *   inputTokens: 1500,
   *   outputTokens: 800,
   * }, machineId);
   */
  async storeMessage(data: StoreMessageData, machineId: string): Promise<MessageRecord> {
    // Get next sequence number
    const sequenceNumber = this.getNextSequence(data.sessionId);

    this.log('Storing message', {
      sessionId: data.sessionId,
      messageType: data.messageType,
      sequenceNumber,
    });

    // Encrypt message content
    const encryptionKey = await this.getSessionKey(data.sessionId, machineId);
    const encrypted = encryptMessage(data.content, encryptionKey);

    const { data: message, error } = await this.supabase
      .from('session_messages')
      .insert({
        session_id: data.sessionId,
        sequence_number: sequenceNumber,
        parent_message_id: data.parentMessageId,
        message_type: data.messageType,
        content_encrypted: encrypted.contentEncrypted,
        encryption_nonce: encrypted.nonce,
        risk_level: data.riskLevel,
        permission_granted: data.permissionGranted,
        tool_name: data.toolName,
        duration_ms: data.durationMs,
        input_tokens: data.inputTokens ?? 0,
        output_tokens: data.outputTokens ?? 0,
        cache_tokens: data.cacheTokens ?? 0,
        metadata: data.metadata ?? {},
      })
      .select()
      .single();

    if (error) {
      this.log('Failed to store message', { error: error.message });
      throw new Error(`Failed to store message: ${error.message}`);
    }

    return message as MessageRecord;
  }

  /**
   * Retrieve and decrypt messages for a session.
   *
   * Returns messages in sequence order with decrypted content.
   *
   * @param sessionId - Session to retrieve messages from
   * @param machineId - Machine ID for decryption key
   * @param options - Query options
   * @returns Array of messages with decrypted content
   */
  async getMessages(
    sessionId: string,
    machineId: string,
    options?: {
      limit?: number;
      offset?: number;
      afterSequence?: number;
    }
  ): Promise<Array<MessageRecord & { content?: string }>> {
    let query = this.supabase
      .from('session_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('sequence_number', { ascending: true });

    if (options?.afterSequence !== undefined) {
      query = query.gt('sequence_number', options.afterSequence);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit ?? 50) - 1);
    }

    const { data: messages, error } = await query;

    if (error) {
      throw new Error(`Failed to get messages: ${error.message}`);
    }

    // Decrypt messages
    const encryptionKey = await this.getSessionKey(sessionId, machineId);

    return (messages as MessageRecord[]).map((msg) => {
      let content: string | undefined;

      if (msg.content_encrypted && msg.encryption_nonce) {
        try {
          content = decryptMessage(
            {
              contentEncrypted: msg.content_encrypted,
              nonce: msg.encryption_nonce,
            },
            encryptionKey
          );
        } catch (decryptError) {
          this.log('Failed to decrypt message', {
            messageId: msg.id,
            error: decryptError instanceof Error ? decryptError.message : 'Unknown error',
          });
          content = '[Decryption failed]';
        }
      }

      return { ...msg, content };
    });
  }

  // --------------------------------------------------------------------------
  // Session Queries
  // --------------------------------------------------------------------------

  /**
   * Get a single session by ID.
   *
   * @param sessionId - Session to retrieve
   * @returns Session record or null if not found
   */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return null;
      }
      throw new Error(`Failed to get session: ${error.message}`);
    }

    return data as SessionRecord;
  }

  /**
   * List sessions for the current user.
   *
   * Returns sessions ordered by creation date (newest first).
   * Includes a computed duration field.
   *
   * @param userId - User to list sessions for
   * @param options - Query options
   * @returns Array of session list items
   *
   * @example
   * const sessions = await storage.listSessions(userId, {
   *   limit: 20,
   *   agentType: 'claude',
   * });
   */
  async listSessions(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
      agentType?: AgentType;
      status?: SessionStatus | SessionStatus[];
      archived?: boolean;
    }
  ): Promise<SessionListItem[]> {
    let query = this.supabase
      .from('sessions')
      .select(
        'id, agent_type, model, title, status, started_at, ended_at, total_cost_usd, message_count, last_activity_at'
      )
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (options?.agentType) {
      query = query.eq('agent_type', options.agentType);
    }

    if (options?.status) {
      if (Array.isArray(options.status)) {
        query = query.in('status', options.status);
      } else {
        query = query.eq('status', options.status);
      }
    }

    if (options?.archived !== undefined) {
      query = query.eq('is_archived', options.archived);
    } else {
      // Default to non-archived
      query = query.eq('is_archived', false);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit ?? 50) - 1);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list sessions: ${error.message}`);
    }

    return (data as Array<Record<string, unknown>>).map((row) =>
      this.mapToSessionListItem(row)
    );
  }

  /**
   * Get recent active sessions for quick access.
   *
   * Returns sessions that are running, idle, or paused,
   * ordered by last activity.
   *
   * @param userId - User to get sessions for
   * @param limit - Maximum number of sessions to return
   * @returns Array of active session list items
   */
  async getActiveSessions(userId: string, limit: number = 5): Promise<SessionListItem[]> {
    return this.listSessions(userId, {
      limit,
      status: ['running', 'idle', 'paused'],
    });
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  /**
   * Get or derive encryption key for a session.
   * Automatically prunes the cache when it exceeds the maximum size.
   */
  private async getSessionKey(sessionId: string, machineId: string): Promise<Uint8Array> {
    const cacheKey = `${sessionId}:${machineId}`;

    if (!this.keyCache.has(cacheKey)) {
      // Prune cache before adding new entry to prevent unbounded growth
      this.pruneKeyCache();

      const key = await deriveSessionKey({
        userSecret: this.userSecret,
        sessionId,
        machineId,
      });
      this.keyCache.set(cacheKey, key);
    }

    return this.keyCache.get(cacheKey)!;
  }

  /**
   * Get next sequence number for a session.
   */
  private getNextSequence(sessionId: string): number {
    const current = this.sequenceCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(sessionId, next);
    return next;
  }

  /**
   * Map database row to SessionListItem.
   */
  private mapToSessionListItem(row: Record<string, unknown>): SessionListItem {
    const startedAt = new Date(row.started_at as string);
    const endedAt = row.ended_at ? new Date(row.ended_at as string) : undefined;
    const lastActivityAt = new Date(row.last_activity_at as string);

    // Calculate duration
    const endTime = endedAt ?? new Date();
    const durationMs = endTime.getTime() - startedAt.getTime();

    return {
      id: row.id as string,
      agentType: row.agent_type as AgentType,
      model: row.model as string | undefined,
      title: row.title as string | undefined,
      status: row.status as SessionStatus,
      startedAt,
      endedAt,
      totalCostUsd: row.total_cost_usd as number,
      messageCount: row.message_count as number,
      lastActivityAt,
      durationMs,
    };
  }

  /**
   * Log with module context.
   */
  private log(message: string, data?: Record<string, unknown>): void {
    if (this.debug) {
      logger.debug(`[SessionStorage] ${message}`, data);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a session storage instance.
 *
 * @param config - Storage configuration
 * @returns Configured SessionStorage instance
 *
 * @example
 * const storage = createSessionStorage({
 *   supabase: authenticatedClient,
 *   userSecret: derivedUserSecret,
 *   debug: true,
 * });
 */
export function createSessionStorage(config: SessionStorageConfig): SessionStorage {
  return new SessionStorage(config);
}

export default {
  SessionStorage,
  createSessionStorage,
};
