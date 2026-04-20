/**
 * useWebhooks Hook
 *
 * Manages user webhook configurations: fetching, creating, updating,
 * toggling status (active/paused), testing, deleting, and fetching
 * recent delivery logs. Enforces Power-tier gating — callers should
 * check `isPowerTier` and `webhookLimit` before showing create UI.
 *
 * API surface (all routed through the Next.js web app):
 *   GET    /api/webhooks/user              — list webhooks
 *   POST   /api/webhooks/user              — create webhook
 *   PATCH  /api/webhooks/user              — update / toggle webhook
 *   DELETE /api/webhooks/user              — delete webhook
 *   POST   /api/webhooks/user/test         — send a test delivery
 *   GET    /api/webhooks/user/deliveries   — recent delivery attempts
 */

import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';
import { supabase } from '../lib/supabase';
import { getApiBaseUrl } from '../lib/config';

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Shape of a single webhook record as returned by GET /api/webhooks/user.
 */
const WebhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  is_active: z.boolean(),
  last_success_at: z.string().nullable(),
  last_failure_at: z.string().nullable(),
  consecutive_failures: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Shape of a single delivery record returned by GET /api/webhooks/user/deliveries.
 */
const WebhookDeliverySchema = z.object({
  id: z.string(),
  webhook_id: z.string(),
  event_type: z.string(),
  status_code: z.number().nullable(),
  success: z.boolean(),
  attempt_number: z.number(),
  error_message: z.string().nullable(),
  created_at: z.string(),
});

/**
 * GET /api/webhooks/user response envelope.
 */
const WebhooksResponseSchema = z.object({
  webhooks: z.array(WebhookSchema),
  tier: z.string(),
  webhookLimit: z.number(),
  webhookCount: z.number(),
});

/**
 * GET /api/webhooks/user/deliveries response envelope.
 */
const DeliveriesResponseSchema = z.object({
  deliveries: z.array(WebhookDeliverySchema),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Valid webhook event type values. Matches the server-side enum.
 * WHY: Defined as a string union instead of z.infer<typeof z.enum([...])>
 * because the schema was only used for type inference — no runtime validation.
 */
export type WebhookEvent = 'session.started' | 'session.completed' | 'budget.exceeded' | 'permission.requested';

/** A webhook record. */
export type Webhook = z.infer<typeof WebhookSchema>;

/** A webhook delivery log entry. */
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

/**
 * Input for creating a new webhook.
 */
export interface CreateWebhookInput {
  /** Human-readable label for the webhook */
  name: string;
  /** HTTPS URL to deliver events to */
  url: string;
  /** Events that should trigger this webhook */
  events: WebhookEvent[];
}

/**
 * Input for updating an existing webhook.
 */
export interface UpdateWebhookInput {
  /** New human-readable label */
  name?: string;
  /** New HTTPS URL */
  url?: string;
  /** New event set */
  events?: WebhookEvent[];
  /** Whether the webhook should be active */
  is_active?: boolean;
}

/**
 * Return type for the useWebhooks hook.
 */
export interface UseWebhooksResult {
  /** User's webhooks, most-recently-created first */
  webhooks: Webhook[];
  /** True while the initial fetch is in progress */
  isLoading: boolean;
  /** True while a create / update / delete / test operation is running */
  isMutating: boolean;
  /** Error message from the last failed operation, or null */
  error: string | null;
  /** User's subscription tier */
  tier: string;
  /** Maximum webhooks allowed on this tier (0 = feature unavailable) */
  webhookLimit: number;
  /** Number of currently active + inactive webhooks */
  webhookCount: number;
  /** True when the user is on the Power tier */
  isPowerTier: boolean;
  /** Re-fetch webhooks from the server */
  refresh: () => Promise<void>;
  /** Create a new webhook; returns the created record or null on failure */
  createWebhook: (input: CreateWebhookInput) => Promise<Webhook | null>;
  /** Update an existing webhook; returns true on success */
  updateWebhook: (id: string, input: UpdateWebhookInput) => Promise<boolean>;
  /** Delete a webhook; returns true on success */
  deleteWebhook: (id: string) => Promise<boolean>;
  /** Toggle a webhook between active and paused; returns true on success */
  toggleWebhook: (id: string, isActive: boolean) => Promise<boolean>;
  /** Send a test delivery for the given webhook; returns true on success */
  testWebhook: (id: string) => Promise<boolean>;
  /** Fetch recent deliveries for a webhook */
  fetchDeliveries: (webhookId: string) => Promise<WebhookDelivery[]>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the current session's access token for authenticating API requests.
 *
 * @returns The JWT access token string, or null if the user is not authenticated
 */
async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * Builds the Authorization header for API requests.
 *
 * @param token - The bearer token
 * @returns Header object with Authorization and Content-Type
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
 * Hook for managing user webhook configurations.
 *
 * Fetches the user's webhooks on mount, provides full CRUD operations,
 * and exposes tier information so callers can gate the create flow.
 *
 * @returns Webhook data, loading states, tier info, and action functions
 *
 * @example
 * const {
 *   webhooks, isLoading, isPowerTier, webhookLimit,
 *   createWebhook, deleteWebhook, toggleWebhook, testWebhook,
 * } = useWebhooks();
 *
 * if (!isPowerTier) return <UpgradePrompt />;
 */
export function useWebhooks(): UseWebhooksResult {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState('free');
  const [webhookLimit, setWebhookLimit] = useState(0);
  const [webhookCount, setWebhookCount] = useState(0);

  const isPowerTier = webhookLimit > 0;

  // --------------------------------------------------------------------------
  // Fetch
  // --------------------------------------------------------------------------

  /**
   * Fetches the user's webhooks and tier info from the API.
   *
   * @returns Promise resolving when the fetch completes
   */
  const fetchWebhooks = useCallback(async (): Promise<void> => {
    try {
      const token = await getAccessToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/api/webhooks/user`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to fetch webhooks');
        return;
      }

      const raw: unknown = await response.json();
      const parsed = WebhooksResponseSchema.safeParse(raw);

      if (!parsed.success) {
        setError('Unexpected response from server');
        return;
      }

      setWebhooks(parsed.data.webhooks);
      setTier(parsed.data.tier);
      setWebhookLimit(parsed.data.webhookLimit);
      setWebhookCount(parsed.data.webhookCount);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch webhooks');
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchWebhooks().finally(() => setIsLoading(false));
  }, [fetchWebhooks]);

  /**
   * Public refresh — re-fetches webhooks without the initial loading flag.
   */
  const refresh = useCallback(async (): Promise<void> => {
    await fetchWebhooks();
  }, [fetchWebhooks]);

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  /**
   * Creates a new webhook.
   *
   * @param input - Webhook name, URL, and event types
   * @returns The newly created webhook record, or null if creation failed
   */
  const createWebhook = useCallback(
    async (input: CreateWebhookInput): Promise<Webhook | null> => {
      setIsMutating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          setError('Not authenticated');
          return null;
        }

        const response = await fetch(`${getApiBaseUrl()}/api/webhooks/user`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify(input),
        });

        const body: unknown = await response.json().catch(() => ({}));

        if (!response.ok) {
          const msg = (body as { error?: string }).error ?? 'Failed to create webhook';
          setError(msg);
          return null;
        }

        const webhookParsed = WebhookSchema.safeParse((body as { webhook?: unknown }).webhook ?? body);
        if (!webhookParsed.success) {
          setError('Unexpected response from server');
          return null;
        }

        const created = webhookParsed.data;
        setWebhooks((prev) => [created, ...prev]);
        setWebhookCount((prev) => prev + 1);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create webhook');
        return null;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Update
  // --------------------------------------------------------------------------

  /**
   * Updates an existing webhook's fields.
   *
   * @param id - The webhook ID to update
   * @param input - Fields to update
   * @returns True if the update succeeded
   */
  const updateWebhook = useCallback(
    async (id: string, input: UpdateWebhookInput): Promise<boolean> => {
      setIsMutating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          setError('Not authenticated');
          return false;
        }

        const response = await fetch(`${getApiBaseUrl()}/api/webhooks/user`, {
          method: 'PATCH',
          headers: authHeaders(token),
          body: JSON.stringify({ id, ...input }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? 'Failed to update webhook');
          return false;
        }

        // Optimistic: apply the update locally
        setWebhooks((prev) =>
          prev.map((w) => (w.id === id ? { ...w, ...input, updated_at: new Date().toISOString() } : w))
        );
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update webhook');
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Toggle
  // --------------------------------------------------------------------------

  /**
   * Toggles a webhook between active and paused states.
   *
   * @param id - The webhook ID
   * @param isActive - The desired active state
   * @returns True if the toggle succeeded
   */
  const toggleWebhook = useCallback(
    async (id: string, isActive: boolean): Promise<boolean> => {
      // Optimistic update for responsive UI
      setWebhooks((prev) =>
        prev.map((w) => (w.id === id ? { ...w, is_active: isActive } : w))
      );

      const success = await updateWebhook(id, { is_active: isActive });

      if (!success) {
        // Roll back optimistic update on failure
        setWebhooks((prev) =>
          prev.map((w) => (w.id === id ? { ...w, is_active: !isActive } : w))
        );
      }

      return success;
    },
    [updateWebhook]
  );

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  /**
   * Deletes a webhook permanently.
   *
   * @param id - The webhook ID to delete
   * @returns True if deletion succeeded
   */
  const deleteWebhook = useCallback(
    async (id: string): Promise<boolean> => {
      setIsMutating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          setError('Not authenticated');
          return false;
        }

        const response = await fetch(`${getApiBaseUrl()}/api/webhooks/user`, {
          method: 'DELETE',
          headers: authHeaders(token),
          body: JSON.stringify({ id }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? 'Failed to delete webhook');
          return false;
        }

        setWebhooks((prev) => prev.filter((w) => w.id !== id));
        setWebhookCount((prev) => Math.max(0, prev - 1));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete webhook');
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Test
  // --------------------------------------------------------------------------

  /**
   * Sends a test delivery for a webhook endpoint.
   *
   * WHY: Allows users to verify their endpoint is reachable and correctly
   * processes the Styrby webhook payload format before relying on it in production.
   *
   * @param id - The webhook ID to test
   * @returns True if the test delivery was dispatched successfully
   */
  const testWebhook = useCallback(
    async (id: string): Promise<boolean> => {
      setIsMutating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          setError('Not authenticated');
          return false;
        }

        const response = await fetch(`${getApiBaseUrl()}/api/webhooks/user/test`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ webhook_id: id }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? 'Test delivery failed');
          return false;
        }

        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Test delivery failed');
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Deliveries
  // --------------------------------------------------------------------------

  /**
   * Fetches the most recent delivery attempts for a specific webhook.
   *
   * @param webhookId - The webhook whose deliveries to fetch
   * @returns Array of delivery records (empty array on failure)
   */
  const fetchDeliveries = useCallback(
    async (webhookId: string): Promise<WebhookDelivery[]> => {
      try {
        const token = await getAccessToken();
        if (!token) return [];

        const url = `${getApiBaseUrl()}/api/webhooks/user/deliveries?webhook_id=${encodeURIComponent(webhookId)}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: authHeaders(token),
        });

        if (!response.ok) return [];

        const raw: unknown = await response.json();
        const parsed = DeliveriesResponseSchema.safeParse(raw);
        return parsed.success ? parsed.data.deliveries : [];
      } catch {
        return [];
      }
    },
    []
  );

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    webhooks,
    isLoading,
    isMutating,
    error,
    tier,
    webhookLimit,
    webhookCount,
    isPowerTier,
    refresh,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    toggleWebhook,
    testWebhook,
    fetchDeliveries,
  };
}
