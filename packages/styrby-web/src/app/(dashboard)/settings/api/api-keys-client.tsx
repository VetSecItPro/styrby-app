'use client';

/**
 * API Keys Client Component
 *
 * Interactive UI for managing API keys. Displays key cards with status,
 * usage stats, and controls for creating and revoking keys.
 *
 * WHY this is a client component: It requires interactive state management
 * for modals, clipboard operations, and optimistic UI updates.
 */

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** API key from the database */
interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  last_used_ip: string | null;
  request_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

/** Props from server component */
interface ApiKeysClientProps {
  initialKeys: ApiKey[];
  tier: string;
  keyLimit: number;
  keyCount: number;
}

/** Form data for creating a key */
interface KeyFormData {
  name: string;
  scopes: ('read' | 'write')[];
  expiresInDays: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPIRATION_OPTIONS = [
  { value: null, label: 'Never expires' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days' },
  { value: 365, label: '1 year' },
];

const DEFAULT_FORM_DATA: KeyFormData = {
  name: '',
  scopes: ['read'],
  expiresInDays: null,
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * API keys management interface.
 *
 * Renders a list of API key cards with usage stats and controls,
 * plus modals for creating keys and viewing the secret.
 */
export function ApiKeysClient({
  initialKeys,
  tier,
  keyLimit,
  keyCount: initialCount,
}: ApiKeysClientProps) {
  const router = useRouter();
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [keyCount, setKeyCount] = useState(initialCount);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState<KeyFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canCreateKey = keyLimit > 0 && keyCount < keyLimit;
  const isPowerTier = keyLimit > 0;

  // -------------------------------------------------------------------------
  // Modal Handlers
  // -------------------------------------------------------------------------

  const handleOpenCreate = useCallback(() => {
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setCreatedSecret(null);
    setCopied(false);
    setShowModal(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setCreatedSecret(null);
    setCopied(false);
  }, []);

  // -------------------------------------------------------------------------
  // Create Key Handler
  // -------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          scopes: formData.scopes,
          expires_in_days: formData.expiresInDays,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      // Show the secret to the user (only on creation)
      setCreatedSecret(data.secret);

      // Add to list
      const newKey: ApiKey = {
        ...data.key,
        last_used_at: null,
        last_used_ip: null,
        request_count: 0,
        revoked_at: null,
        revoked_reason: null,
      };
      setKeys((prev) => [newKey, ...prev]);
      setKeyCount((prev) => prev + 1);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [formData]);

  // -------------------------------------------------------------------------
  // Revoke Key Handler
  // -------------------------------------------------------------------------

  const handleRevoke = useCallback(
    async (keyId: string, keyName: string) => {
      if (
        !confirm(
          `Are you sure you want to revoke "${keyName}"? This action cannot be undone and any applications using this key will lose access.`
        )
      ) {
        return;
      }

      setRevokingId(keyId);

      try {
        const response = await fetch('/api/keys', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: keyId }),
        });

        if (response.ok) {
          // Update the key to show as revoked
          setKeys((prev) =>
            prev.map((k) =>
              k.id === keyId ? { ...k, revoked_at: new Date().toISOString() } : k
            )
          );
          setKeyCount((prev) => prev - 1);
          router.refresh();
        }
      } catch {
        // Silent fail - key remains in list
      } finally {
        setRevokingId(null);
      }
    },
    [router]
  );

  // -------------------------------------------------------------------------
  // Copy to Clipboard Handler
  // -------------------------------------------------------------------------

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Separate active and revoked keys
  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <div>
      {/* Header with create button and tier indicator */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <p className="text-sm text-zinc-400">
            {keyCount} / {keyLimit} API keys used
            <span className="text-zinc-600 ml-2">({tier} plan)</span>
          </p>
          <Link
            href="/settings/api/docs"
            className="text-sm text-orange-400 hover:text-orange-300 transition-colors"
          >
            View Documentation
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Back to Settings
          </Link>
          {canCreateKey ? (
            <button
              onClick={handleOpenCreate}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors flex items-center gap-2"
              aria-label="Create a new API key"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create API Key
            </button>
          ) : !isPowerTier ? (
            <Link
              href="/pricing"
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            >
              Upgrade to Power
            </Link>
          ) : (
            <span className="text-sm text-zinc-500">Key limit reached</span>
          )}
        </div>
      </div>

      {/* Not Power tier - upgrade prompt */}
      {!isPowerTier && (
        <div className="rounded-xl bg-gradient-to-br from-orange-500/10 to-orange-600/10 border border-orange-500/30 px-6 py-8 text-center mb-8">
          <div className="mx-auto h-16 w-16 rounded-full bg-orange-500/20 flex items-center justify-center mb-4">
            <svg
              className="h-8 w-8 text-orange-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-zinc-100 mb-2">API Access</h3>
          <p className="text-zinc-400 mb-6 max-w-md mx-auto">
            Unlock programmatic access to your Styrby data with API keys.
            Build integrations, export data, and automate workflows.
          </p>
          <Link
            href="/pricing"
            className="inline-block rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            Upgrade to Power Plan
          </Link>
        </div>
      )}

      {/* Active Keys */}
      {isPowerTier && activeKeys.length === 0 && (
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
          <div className="mx-auto h-16 w-16 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
            <svg
              className="h-8 w-8 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-zinc-100 mb-2">No API Keys</h3>
          <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
            Create an API key to start accessing the Styrby API programmatically.
          </p>
          <button
            onClick={handleOpenCreate}
            className="rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            aria-label="Create your first API key"
          >
            Create Your First API Key
          </button>
        </div>
      )}

      {isPowerTier && activeKeys.length > 0 && (
        <div className="space-y-4 mb-8">
          <h2 className="text-sm font-medium text-zinc-400">Active Keys</h2>
          {activeKeys.map((key) => {
            const isRevoking = revokingId === key.id;
            const isExpired = key.expires_at && new Date(key.expires_at) < new Date();

            return (
              <div
                key={key.id}
                className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 transition-opacity ${
                  isRevoking ? 'opacity-30 pointer-events-none' : ''
                }`}
              >
                {/* Header row */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0 mr-4">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-100">{key.name}</h3>
                      {isExpired && (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-500/10 text-red-400">
                          Expired
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 mt-1 font-mono">
                      {key.key_prefix}{'*'.repeat(24)}
                    </p>
                  </div>
                  {/* Revoke button */}
                  <button
                    onClick={() => handleRevoke(key.id, key.name)}
                    disabled={isRevoking}
                    className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                    aria-label={`Revoke ${key.name}`}
                  >
                    Revoke
                  </button>
                </div>

                {/* Scope badges */}
                <div className="flex flex-wrap gap-2 mb-3">
                  {key.scopes.map((scope) => (
                    <span
                      key={scope}
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-800 text-zinc-400"
                    >
                      {scope}
                    </span>
                  ))}
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-6 text-xs text-zinc-500">
                  <span>
                    Created:{' '}
                    {new Date(key.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                  {key.last_used_at ? (
                    <span className="text-green-400">
                      Last used:{' '}
                      {new Date(key.last_used_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  ) : (
                    <span>Never used</span>
                  )}
                  <span>{key.request_count.toLocaleString()} requests</span>
                  {key.expires_at && (
                    <span>
                      Expires:{' '}
                      {new Date(key.expires_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Revoked Keys */}
      {isPowerTier && revokedKeys.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-500">Revoked Keys</h2>
          {revokedKeys.map((key) => (
            <div
              key={key.id}
              className="rounded-xl bg-zinc-900/50 border border-zinc-800/50 p-4 opacity-60"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-zinc-400">{key.name}</h3>
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-800 text-zinc-500">
                      Revoked
                    </span>
                  </div>
                  <p className="text-xs text-zinc-600 mt-1">
                    Revoked on{' '}
                    {new Date(key.revoked_at!).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Create API key"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={createdSecret ? undefined : handleCloseModal}
            aria-hidden="true"
          />

          {/* Modal content */}
          <div className="relative w-full max-w-lg rounded-xl bg-zinc-900 border border-zinc-800 p-6 shadow-xl">
            {createdSecret ? (
              // Secret display after creation
              <>
                <h2 className="text-lg font-semibold text-zinc-100 mb-4">API Key Created!</h2>
                <div className="mb-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-4 py-3">
                  <p className="text-sm text-yellow-400 mb-3">
                    Save this API key now. You will not be able to see it again!
                  </p>
                  <div className="relative">
                    <code className="block p-3 bg-zinc-800 rounded text-sm text-zinc-100 font-mono break-all pr-12">
                      {createdSecret}
                    </code>
                    <button
                      onClick={() => handleCopy(createdSecret)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
                      aria-label="Copy API key"
                    >
                      {copied ? (
                        <svg
                          className="h-4 w-4 text-green-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      ) : (
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                <p className="text-sm text-zinc-400 mb-6">
                  Use this key in the Authorization header:{' '}
                  <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
                    Bearer {createdSecret.slice(0, 12)}...
                  </code>
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={handleCloseModal}
                    className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              // Create form
              <>
                <h2 className="text-lg font-semibold text-zinc-100 mb-6">Create API Key</h2>

                {/* Error message */}
                {error && (
                  <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3">
                    <p className="text-sm text-red-400">{error}</p>
                  </div>
                )}

                {/* Form fields */}
                <div className="space-y-5">
                  {/* Name */}
                  <div>
                    <label htmlFor="key-name" className="block text-sm font-medium text-zinc-300 mb-1.5">
                      Name
                    </label>
                    <input
                      id="key-name"
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Production Dashboard"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                      maxLength={100}
                    />
                  </div>

                  {/* Expiration */}
                  <div>
                    <label htmlFor="key-expiration" className="block text-sm font-medium text-zinc-300 mb-1.5">
                      Expiration
                    </label>
                    <select
                      id="key-expiration"
                      value={formData.expiresInDays ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          expiresInDays: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    >
                      {EXPIRATION_OPTIONS.map((option) => (
                        <option key={option.label} value={option.value ?? ''}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-zinc-500">
                      For security, we recommend setting an expiration date
                    </p>
                  </div>

                  {/* Info box */}
                  <div className="rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-3">
                    <p className="text-xs text-zinc-400">
                      API keys have read-only access to your sessions, costs, and machines.
                      Rate limit: 100 requests per minute.
                    </p>
                  </div>
                </div>

                {/* Modal actions */}
                <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-zinc-800">
                  <button
                    onClick={handleCloseModal}
                    className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                    disabled={isSubmitting}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={isSubmitting || !formData.name.trim()}
                    className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {isSubmitting && (
                      <div
                        className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                        aria-hidden="true"
                      />
                    )}
                    Create API Key
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
