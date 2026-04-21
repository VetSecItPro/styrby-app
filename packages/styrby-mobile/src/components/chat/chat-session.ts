/**
 * Chat Session Helpers
 *
 * Pure(-ish) helpers that the chat orchestrator calls to read and write
 * sessions and messages in Supabase, including E2E encryption / decryption
 * of message payloads.
 *
 * WHY a dedicated module: Extracting these from `chat.tsx` keeps the
 * orchestrator focused on React state/lifecycle and lets these data-layer
 * functions be unit-tested independently. They take all dependencies as
 * arguments (no React hooks), so they're trivially mockable.
 */

import type { MutableRefObject } from 'react';
import type { AgentType } from 'styrby-shared';
import type { ChatMessageData } from '../ChatMessage';
import type { SessionMessageRow } from '../../types/chat';
import { supabase } from '../../lib/supabase';
import { encryptMessage, decryptMessage } from '../../services/encryption';
import { AGENT_CONFIG, DECRYPTION_FAILED_PLACEHOLDER, chatLogger as logger } from './agent-config';

/**
 * Result returned from {@link loadActiveSession}.
 */
export interface LoadActiveSessionResult {
  /** The session ID resolved from params or the most-recent active row. */
  sessionId: string | null;
  /** Agent type associated with the resumed session, if any. */
  agentType: AgentType | null;
  /** Decrypted messages for the resolved session. */
  messages: ChatMessageData[];
}

/**
 * Resolves the active session and loads its messages.
 *
 * If `existingSessionId` is provided, loads messages for that session.
 * Otherwise, finds the most recent active session for the authenticated user
 * (status in starting/running/idle/paused) and loads its messages.
 *
 * WHY: Centralizes the "resume on mount" flow so the orchestrator only
 * needs a single async call.
 *
 * @param existingSessionId - Session ID from route params, or null to auto-resume
 * @param machineId - Paired CLI machine ID for E2E decryption (null = plaintext only)
 * @returns Resolved session + decrypted message list
 */
export async function loadActiveSession(
  existingSessionId: string | null,
  machineId: string | null,
): Promise<LoadActiveSessionResult> {
  const result: LoadActiveSessionResult = {
    sessionId: existingSessionId,
    agentType: null,
    messages: [],
  };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    logger.log('No authenticated user, skipping session load');
    return result;
  }

  let targetSessionId = existingSessionId;

  // If no session ID from route params, find the most recent active session
  if (!targetSessionId) {
    const { data: recentSession, error: sessionError } = await supabase
      .from('sessions')
      .select('id, agent_type, status')
      .eq('user_id', user.id)
      .in('status', ['starting', 'running', 'idle', 'paused'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionError) {
      logger.error('Failed to find recent session:', sessionError.message);
      return result;
    }

    if (recentSession) {
      targetSessionId = recentSession.id;
      result.sessionId = recentSession.id;

      // WHY: Restore the agent selection to match the resumed session
      // so the UI is consistent with what the user last used.
      if (recentSession.agent_type && recentSession.agent_type in AGENT_CONFIG) {
        result.agentType = recentSession.agent_type as AgentType;
      }

      logger.log('Resuming active session:', recentSession.id);
    }
  }

  if (targetSessionId) {
    result.messages = await loadMessagesForSession(targetSessionId, machineId);
  }

  return result;
}

/**
 * Fetches all messages for a given session and decrypts them.
 *
 * Handles three content scenarios per message:
 * 1. Encrypted (`content_encrypted` + `encryption_nonce` populated): decrypt using E2E keys
 * 2. Plaintext fallback (`content_encrypted` populated, `encryption_nonce` null): use as-is
 * 3. Decryption failure: show {@link DECRYPTION_FAILED_PLACEHOLDER}
 *
 * @param targetSessionId - The session ID to load messages for
 * @param machineId - Paired CLI machine ID for decryption (null = plaintext only)
 * @returns Array of decrypted, UI-ready ChatMessageData
 */
export async function loadMessagesForSession(
  targetSessionId: string,
  machineId: string | null,
): Promise<ChatMessageData[]> {
  const { data: messageRows, error } = await supabase
    .from('session_messages')
    .select('*')
    .eq('session_id', targetSessionId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Failed to load messages:', error.message);
    return [];
  }

  if (!messageRows || messageRows.length === 0) {
    return [];
  }

  const loadedMessages: ChatMessageData[] = await Promise.all(
    (messageRows as SessionMessageRow[]).map(async (row) => {
      let messageContent: string;

      if (row.content_encrypted && row.encryption_nonce && machineId) {
        // WHY: Message is E2E encrypted. Attempt decryption using the
        // paired CLI machine's public key and our secret key.
        try {
          messageContent = await decryptMessage(row.content_encrypted, row.encryption_nonce, machineId);
        } catch (decryptError) {
          logger.error(`Failed to decrypt message ${row.id}:`, decryptError);
          messageContent = DECRYPTION_FAILED_PLACEHOLDER;
        }
      } else if (row.content_encrypted !== null) {
        // WHY: content_encrypted may contain plaintext if encryption
        // was unavailable at send time.
        messageContent = row.content_encrypted;
      } else {
        // WHY: Neither encrypted nor plaintext content available.
        // Handle gracefully rather than crashing.
        messageContent = DECRYPTION_FAILED_PLACEHOLDER;
      }

      // Map message_type to role for the chat UI
      const uiRole = (['user_prompt'].includes(row.message_type))
        ? 'user' as const
        : (['tool_use', 'tool_result', 'system', 'permission_request', 'permission_response'].includes(row.message_type))
          ? 'system' as const
          : 'assistant' as const;

      return {
        id: row.id,
        role: uiRole,
        content: [{ type: 'text' as const, content: messageContent }],
        timestamp: row.created_at,
      };
    }),
  );

  logger.log(`Loaded ${loadedMessages.length} messages for session ${targetSessionId}`);
  return loadedMessages;
}

/**
 * Creates a new session row in Supabase, with locking to prevent race
 * conditions when the user sends multiple messages rapidly.
 *
 * WHY lazy creation: Opening the chat screen without sending a message
 * should not litter the database with empty sessions, so this is called
 * only on the first user message.
 *
 * @param agent - The agent type for this session (defaults to 'claude' if null)
 * @param firstMessageContent - First message content, used to derive a session title
 * @param machineId - Paired CLI machine ID, or null
 * @param currentSessionId - Already-resolved session ID (returned as-is if set)
 * @param creationLock - Mutable ref used to serialize concurrent creation attempts
 * @returns The new session ID, or null if creation failed
 */
export async function createSession(
  agent: AgentType | null,
  firstMessageContent: string,
  machineId: string | null,
  currentSessionId: string | null,
  creationLock: MutableRefObject<boolean>,
): Promise<string | null> {
  // WHY: Prevent race condition if user taps send rapidly
  if (creationLock.current) {
    logger.log('Session creation already in progress, waiting...');
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!creationLock.current) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });
    return currentSessionId;
  }

  // Double-check: session may have been created while we waited
  if (currentSessionId) return currentSessionId;

  creationLock.current = true;

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      logger.error('Cannot create session: no authenticated user');
      return null;
    }

    // WHY: Generate a short title from the first message so the session
    // is identifiable in the session list/history screen.
    const title = firstMessageContent.length > 80
      ? firstMessageContent.substring(0, 77) + '...'
      : firstMessageContent;

    const { data: newSession, error } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        machine_id: machineId ?? null,
        agent_type: agent ?? 'claude',
        status: 'running',
        title,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create session:', error.message);
      return null;
    }

    const newId = newSession.id;
    logger.log('Created new session:', newId);
    return newId;
  } finally {
    creationLock.current = false;
  }
}

/**
 * Token-usage payload optionally attached to persisted messages.
 */
export interface SaveMessageTokenData {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
}

/**
 * Persists a message to `session_messages` with optional E2E encryption.
 *
 * When `machineId` is set, the content is NaCl-encrypted before storage
 * and the plaintext is dropped (privacy guarantee). If encryption fails,
 * falls back to plaintext storage so the message is never lost.
 *
 * @param targetSessionId - The session this message belongs to
 * @param messageId - Unique message ID (used as the PK)
 * @param role - The message role (user, assistant, system, tool)
 * @param content - Plaintext message content (will be encrypted if possible)
 * @param machineId - Paired CLI machine ID for encryption, or null
 * @param tokenData - Optional token usage and cost data
 */
export async function saveMessageToDb(
  targetSessionId: string,
  messageId: string,
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  machineId: string | null,
  tokenData?: SaveMessageTokenData,
): Promise<void> {
  let encryptedContent: string | null = null;
  let encryptionNonce: string | null = null;
  let plaintextContent: string | null = content;

  // WHY: Attempt E2E encryption when a paired machine is available.
  // If encryption fails, fall back to plaintext storage. This ensures
  // messages are always saved even if the encryption infrastructure
  // is temporarily unavailable.
  if (machineId) {
    try {
      const encrypted = await encryptMessage(content, machineId);
      encryptedContent = encrypted.encrypted;
      encryptionNonce = encrypted.nonce;
      // WHY: When encryption succeeds, drop plaintext so the server
      // never stores readable content. Core privacy guarantee of E2E.
      plaintextContent = null;
    } catch (encryptError) {
      // WHY: Encryption failure is not fatal. Fall back to plaintext so
      // the user's message is not lost. Common causes:
      // - The CLI has not yet registered its public key
      // - Key rotation in progress
      // - SecureStore temporarily unavailable
      logger.error('Encryption failed, falling back to plaintext:', encryptError);
    }
  }

  // WHY column names: session_messages uses message_type (not role),
  // content_encrypted (not content/encrypted_content), and
  // encryption_nonce (not nonce). cost_usd / model live on cost_records
  // and sessions respectively.
  const { error } = await supabase
    .from('session_messages')
    .insert({
      id: messageId,
      session_id: targetSessionId,
      message_type: role === 'user' ? 'user_prompt' : 'agent_response',
      content_encrypted: encryptedContent || plaintextContent,
      encryption_nonce: encryptionNonce,
      input_tokens: tokenData?.inputTokens ?? null,
      output_tokens: tokenData?.outputTokens ?? null,
    });

  if (error) {
    logger.error('Failed to save message:', error.message);
  }
}
