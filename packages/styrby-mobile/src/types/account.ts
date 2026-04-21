/**
 * Account Settings — Domain Types
 *
 * Shared type definitions for the Account settings screen and its
 * sub-components.
 *
 * WHY: Hoisted out of `app/settings/account.tsx` during the orchestrator
 * refactor so every sub-component imports from one stable location instead
 * of from a screen file.
 */

/**
 * The exact phrase a user must type to confirm permanent account deletion.
 *
 * WHY exported as a type-adjacent constant: shared by the iOS Alert.prompt
 * path, the Android modal, and the server-side DELETE endpoint payload.
 * Co-located with types so all consumers get a single source of truth.
 */
export const DELETE_CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT' as const;

/**
 * Type alias for the deletion confirmation phrase. Useful for narrowing
 * unverified user input before sending it to the deletion endpoint.
 */
export type DeleteConfirmationPhrase = typeof DELETE_CONFIRMATION_PHRASE;

/**
 * Minimal current-user shape consumed by Account sub-components.
 *
 * WHY a local interface instead of importing from the auth hook: keeps the
 * sub-components decoupled from the hook's full return type so they can be
 * tested in isolation with a synthetic user object.
 */
export interface AccountUser {
  /** Supabase auth user id (UUID) */
  id: string;
  /** User's current email address (may be undefined while loading) */
  email?: string;
  /** Display name from profiles.display_name (may be undefined) */
  displayName?: string;
}
