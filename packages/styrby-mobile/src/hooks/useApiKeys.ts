/**
 * useApiKeys Hook
 *
 * Manages the user's API keys: listing, creating, and revoking.
 * Power tier only — callers must check `isPowerTier` before allowing creation.
 *
 * Security model:
 * - Plaintext key is returned ONCE on creation. After that, only the prefix
 *   (sk_...xxxx) is accessible. The hook surfaces the plaintext through the
 *   `createKey` return value; callers are responsible for showing it once
 *   and never caching it.
 * - Revoked keys remain in the list (with revoked_at set) for audit visibility.
 *
 * API surface (routed through the Next.js web app):
 *   GET    /api/keys  — list all keys (no hashes)
 *   POST   /api/keys  — create a key (returns plaintext once)
 *   DELETE /api/keys  — revoke a key
 */

import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';
import { supabase } from '../lib/supabase';
import { getApiBaseUrl } from '../lib/config';

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Shape of an API key record returned by the server (no key_hash field).
 */
const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  scopes: z.array(z.string()),
  last_used_at: z.string().nullable(),
  last_used_ip: z.string().nullable(),
  request_count: z.number(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  revoked_reason: z.string().nullable(),
  created_at: z.string(),
});

/**
 * GET /api/keys response envelope.
 */
const ApiKeysResponseSchema = z.object({
  keys: z.array(ApiKeySchema),
  tier: z.string(),
  keyLimit: z.number(),
  keyCount: z.number(),
});

/**
 * POST /api/keys response envelope — includes the one-time plaintext secret.
 */
const CreateKeyResponseSchema = z.object({
  key: ApiKeySchema,
  secret: z.string(),
});

// ============================================================================
// Types
// ============================================================================

/** An API key record (without the hash). */
export type ApiKey = z.infer<typeof ApiKeySchema>;

/**
 * Input for creating a new API key.
 */
export interface CreateApiKeyInput {
  /** Human-readable name for the key */
  name: string;
  /** Permission scopes for the key */
  scopes?: ('read' | 'write')[];
  /** Number of days until the key expires (null = never) */
  expires_in_days?: number | null;
}

/**
 * Result returned on successful key creation — includes the one-time secret.
 */
export interface CreatedApiKey {
  /** The key metadata record */
  key: ApiKey;
  /**
   * The plaintext API key.
   * WHY: This is only available at creation time. Styrby hashes keys with
   * bcrypt and never stores the plaintext. Once the user dismisses the
   * creation modal, this value is gone forever.
   */
  secret: string;
}

/**
 * Return type for the useApiKeys hook.
 */
export interface UseApiKeysResult {
  /** User's API keys (including revoked), newest first */
  keys: ApiKey[];
  /** True while the initial list fetch is in progress */
  isLoading: boolean;
  /** True while a create or revoke operation is running */
  isMutating: boolean;
  /** Error message from the last failed operation, or null */
  error: string | null;
  /** User's subscription tier */
  tier: string;
  /** Maximum active keys allowed on this tier (0 = feature unavailable) */
  keyLimit: number;
  /** Number of currently active (non-revoked) keys */
  keyCount: number;
  /** True when the user is on the Power tier */
  isPowerTier: boolean;
  /** Re-fetch keys from the server */
  refresh: () => Promise<void>;
  /**
   * Creates a new API key.
   *
   * @returns Object with the key metadata and the one-time plaintext secret,
   *          or null if creation failed.
   */
  createKey: (input: CreateApiKeyInput) => Promise<CreatedApiKey | null>;
  /**
   * Revokes an API key. The key is soft-deleted (revoked_at set).
   *
   * @param id - The key ID to revoke
   * @param reason - Optional reason for revocation (for the audit log)
   * @returns True if revocation succeeded
   */
  revokeKey: (id: string, reason?: string) => Promise<boolean>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the current session's bearer token.
 *
 * @returns The JWT access token, or null if the user is not authenticated
 */
async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * Builds JSON + Authorization headers for API requests.
 *
 * @param token - The bearer token
 * @returns Header map
 */
function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing API keys.
 *
 * Loads the key list on mount and provides functions for creating and
 * revoking keys. Surfaces tier information so callers can gate the UI.
 *
 * @returns API key data, loading states, tier info, and action functions
 *
 * @example
 * const { keys, isLoading, isPowerTier, createKey, revokeKey } = useApiKeys();
 *
 * if (!isPowerTier) return <UpgradePrompt />;
 *
 * const result = await createKey({ name: 'CI Integration' });
 * if (result) {
 *   showSecretModal(result.secret); // show ONCE, then discard
 * }
 */
export function useApiKeys(): UseApiKeysResult {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState('free');
  const [keyLimit, setKeyLimit] = useState(0);
  const [keyCount, setKeyCount] = useState(0);

  const isPowerTier = keyLimit > 0;

  // --------------------------------------------------------------------------
  // Fetch
  // --------------------------------------------------------------------------

  /**
   * Fetches the key list and tier info from the API.
   */
  const fetchKeys = useCallback(async (): Promise<void> => {
    try {
      const token = await getAccessToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/api/keys`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to fetch API keys');
        return;
      }

      const raw: unknown = await response.json();
      const parsed = ApiKeysResponseSchema.safeParse(raw);

      if (!parsed.success) {
        setError('Unexpected response from server');
        return;
      }

      setKeys(parsed.data.keys);
      setTier(parsed.data.tier);
      setKeyLimit(parsed.data.keyLimit);
      setKeyCount(parsed.data.keyCount);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch API keys');
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchKeys().finally(() => setIsLoading(false));
  }, [fetchKeys]);

  /**
   * Public refresh — re-fetches without the initial loading flag.
   */
  const refresh = useCallback(async (): Promise<void> => {
    await fetchKeys();
  }, [fetchKeys]);

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  /**
   * Creates a new API key.
   *
   * The server returns the plaintext key ONCE. Callers must display it
   * immediately and instruct the user to copy it — it cannot be retrieved again.
   *
   * @param input - Key name, scopes, and optional expiration
   * @returns Object with key metadata and one-time plaintext secret, or null on failure
   */
  const createKey = useCallback(
    async (input: CreateApiKeyInput): Promise<CreatedApiKey | null> => {
      setIsMutating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          setError('Not authenticated');
          return null;
        }

        const body = {
          name: input.name,
          scopes: input.scopes ?? ['read'],
          ...(input.expires_in_days != null && { expires_in_days: input.expires_in_days }),
        };

        const response = await fetch(`${getApiBaseUrl()}/api/keys`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify(body),
        });

        const raw: unknown = await response.json().catch(() => ({}));

        if (!response.ok) {
          const msg = (raw as { error?: string }).error ?? 'Failed to create API key';
          setError(msg);
          return null;
        }

        const parsed = CreateKeyResponseSchema.safeParse(raw);
        if (!parsed.success) {
          setError('Unexpected response from server');
          return null;
        }

        const { key, secret } = parsed.data;
        setKeys((prev) => [key, ...prev]);
        setKeyCount((prev) => prev + 1);

        return { key, secret };
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create API key');
        return null;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Revoke
  // --------------------------------------------------------------------------

  /**
   * Revokes an API key.
   *
   * WHY soft delete: Revoked keys remain in the database for audit trail
   * purposes. The key can no longer authenticate requests, but the record
   * is preserved so administrators can review past key usage.
   *
   * @param id - The key ID to revoke
   * @param reason - Optional human-readable reason for revocation
   * @returns True if the revocation succeeded
   */
  const revokeKey = useCallback(
    async (id: string, reason?: string): Promise<boolean> => {
      setIsMutating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          setError('Not authenticated');
          return false;
        }

        const response = await fetch(`${getApiBaseUrl()}/api/keys`, {
          method: 'DELETE',
          headers: authHeaders(token),
          body: JSON.stringify({ id, ...(reason && { reason }) }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? 'Failed to revoke API key');
          return false;
        }

        // Mark key as revoked locally so the list updates immediately
        const revokedAt = new Date().toISOString();
        setKeys((prev) =>
          prev.map((k) =>
            k.id === id
              ? { ...k, revoked_at: revokedAt, revoked_reason: reason ?? null }
              : k
          )
        );
        setKeyCount((prev) => Math.max(0, prev - 1));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to revoke API key');
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    keys,
    isLoading,
    isMutating,
    error,
    tier,
    keyLimit,
    keyCount,
    isPowerTier,
    refresh,
    createKey,
    revokeKey,
  };
}
