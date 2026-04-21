/**
 * Chat Types
 *
 * Shared type definitions for the chat screen and its sub-components.
 *
 * WHY a dedicated module: The orchestrator (`app/(tabs)/chat.tsx`) and
 * its presentational sub-components in `src/components/chat/` all need
 * consistent shapes for messages, permissions, and persisted rows.
 * Centralizing here prevents inline-type drift between files.
 */

import type { ChatMessageData } from '../components/ChatMessage';
import type { PermissionRequest } from '../components/PermissionCard';

/**
 * Maps to the actual `session_messages` table schema in Supabase.
 *
 * WHY: Column names must match exactly — Supabase returns actual DB column
 * names, not aliases. Previous bugs were caused by using `role`, `content`,
 * `encrypted_content`, `nonce` instead of the real column names.
 *
 * Encryption strategy:
 * - When E2E encryption is active: `content_encrypted` holds NaCl ciphertext,
 *   `encryption_nonce` holds the nonce.
 * - Backward compatibility: if `encryption_nonce` is null, `content_encrypted`
 *   may contain plaintext (encryption was unavailable at send time).
 */
export interface SessionMessageRow {
  /** UUID primary key */
  id: string;
  /** Foreign key to `sessions.id` */
  session_id: string;
  /** Message type enum: user_prompt, agent_response, tool_use, etc. */
  message_type: string;
  /** Base64-encoded NaCl box ciphertext (or plaintext for unencrypted messages) */
  content_encrypted: string | null;
  /** Base64-encoded NaCl nonce used for encryption (null for plaintext) */
  encryption_nonce: string | null;
  /** Input tokens consumed by this message */
  input_tokens: number | null;
  /** Output tokens produced by this message */
  output_tokens: number | null;
  /** Duration in milliseconds */
  duration_ms: number | null;
  /** When the message was created (ISO 8601) */
  created_at: string;
}

/**
 * A discriminated union representing one entry in the chat list.
 *
 * WHY: Messages and pending permissions are merged into a single sorted
 * stream so they appear in chronological order in the FlatList. The `type`
 * field drives which component renders the entry.
 */
export type ChatItem =
  | { type: 'message'; data: ChatMessageData }
  | { type: 'permission'; data: PermissionRequest };
