'use client';

/**
 * SSO Settings Panel (Client Component)
 *
 * Interactive form for managing team Google SSO settings.
 *
 * Features:
 *   - Set / update SSO domain (owners only)
 *   - Toggle require_sso (owners only)
 *   - Clear SSO domain (owners only)
 *   - Display enrolled member count
 *   - Recent SSO audit events table
 *
 * Security UX:
 *   - require_sso toggle shows a confirmation dialog explaining the consequence
 *   - Clearing the domain automatically resets require_sso to false (shown in UI)
 *   - All changes are previewed before submission
 *
 * @module dashboard/team/[teamId]/sso/sso-settings-panel
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Lock, Mail, Users, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ============================================================================
// Types
// ============================================================================

interface AuditEvent {
  id: string;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface SsoSettingsPanelProps {
  teamId: string;
  teamName: string;
  ssoDomain: string | null;
  requireSso: boolean;
  enrolledCount: number;
  recentEvents: AuditEvent[];
  isOwner: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Regex for validating domain format in the client form.
 * WHY: Provides immediate feedback before the server-side Zod validation.
 * Matches the server-side regex for consistency.
 */
const DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns a human-readable label for an audit event action.
 *
 * @param action - The audit_action enum value
 * @returns Display string for the event
 */
function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    team_sso_enrolled: 'SSO auto-enrolled',
    team_sso_domain_set: 'SSO domain updated',
    team_sso_domain_cleared: 'SSO domain cleared',
    team_sso_rejected: 'SSO enrollment rejected',
    team_require_sso_toggled: 'Require SSO toggled',
  };
  return labels[action] ?? action;
}

/**
 * Returns an icon component for an audit event action.
 *
 * @param action - The audit_action enum value
 * @returns JSX icon element
 */
function AuditActionIcon({ action }: { action: string }) {
  if (action === 'team_sso_enrolled') return <CheckCircle className="h-4 w-4 text-green-400" aria-hidden />;
  if (action === 'team_sso_rejected') return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
  return <Shield className="h-4 w-4 text-amber-400" aria-hidden />;
}

/**
 * Formats an ISO date string to a localized short date+time.
 *
 * @param iso - ISO 8601 date string
 * @returns Formatted date string
 */
function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============================================================================
// Component
// ============================================================================

/**
 * SSO Settings Panel for team admin.
 *
 * WHY component-first: Kept as a standalone client component to allow the
 * server page to stay as a thin orchestrator. All form state and mutation
 * logic lives here, not in the page.
 */
export function SsoSettingsPanel({
  teamId,
  teamName,
  ssoDomain: initialDomain,
  requireSso: initialRequireSso,
  enrolledCount,
  recentEvents,
  isOwner,
}: SsoSettingsPanelProps) {
  const router = useRouter();

  // Form state
  const [domain, setDomain] = useState(initialDomain ?? '');
  const [requireSso, setRequireSso] = useState(initialRequireSso);
  const [domainError, setDomainError] = useState<string | null>(null);

  // Operation state
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Confirmation dialog for require_sso=true (destructive)
  const [showSsoConfirm, setShowSsoConfirm] = useState(false);

  /**
   * Validates the domain field on change.
   *
   * @param value - The raw input value
   */
  function handleDomainChange(value: string) {
    const normalized = value.trim().toLowerCase();
    setDomain(normalized);
    setDomainError(null);

    if (normalized && !DOMAIN_REGEX.test(normalized)) {
      setDomainError('Enter a valid domain like "example.com"');
    }
  }

  /**
   * Handles the require_sso toggle.
   * WHY confirmation dialog: Setting require_sso=true locks all non-Google
   * members out of the team. We want explicit acknowledgment before enabling.
   *
   * @param checked - The new toggle value
   */
  function handleRequireSsoChange(checked: boolean) {
    if (checked && !requireSso) {
      // Show confirmation before enabling
      setShowSsoConfirm(true);
    } else {
      setRequireSso(checked);
    }
  }

  /**
   * Confirms enabling require_sso after the user reads the warning.
   */
  function confirmEnableSso() {
    setRequireSso(true);
    setShowSsoConfirm(false);
  }

  /**
   * Saves SSO settings (domain and/or require_sso).
   */
  async function handleSave() {
    setSaveMessage(null);

    if (domain && !DOMAIN_REGEX.test(domain)) {
      setDomainError('Enter a valid domain like "example.com"');
      return;
    }

    setSaving(true);

    try {
      const body: Record<string, unknown> = {};
      if (domain !== (initialDomain ?? '')) {
        body.sso_domain = domain || null;
      }
      if (requireSso !== initialRequireSso) {
        body.require_sso = requireSso;
      }

      if (Object.keys(body).length === 0) {
        setSaveMessage({ type: 'error', text: 'No changes to save.' });
        return;
      }

      // Use PUT to set, DELETE to clear (domain cleared + require_sso reset)
      const method = domain ? 'PUT' : 'DELETE';
      const url = `/api/teams/${teamId}/sso`;
      const fetchOptions: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (method === 'PUT') {
        fetchOptions.body = JSON.stringify(body);
      }

      const res = await fetch(url, fetchOptions);
      const data = await res.json();

      if (!res.ok) {
        setSaveMessage({ type: 'error', text: data.error ?? 'Failed to save SSO settings.' });
      } else {
        setSaveMessage({ type: 'success', text: 'SSO settings saved.' });
        router.refresh();
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  /**
   * Clears the SSO domain (disables auto-enroll and resets require_sso).
   */
  async function handleClear() {
    setClearing(true);
    setSaveMessage(null);

    try {
      const res = await fetch(`/api/teams/${teamId}/sso`, { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        setSaveMessage({ type: 'error', text: data.error ?? 'Failed to clear SSO settings.' });
      } else {
        setDomain('');
        setRequireSso(false);
        setSaveMessage({ type: 'success', text: 'SSO domain cleared. Auto-enroll is disabled.' });
        router.refresh();
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setClearing(false);
    }
  }

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="space-y-8">
      {/* Status cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border/60 bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Shield className="h-4 w-4" aria-hidden />
            SSO Domain
          </div>
          <p className="font-mono text-sm font-medium text-foreground truncate">
            {initialDomain ?? (
              <span className="text-muted-foreground font-sans font-normal">Not configured</span>
            )}
          </p>
        </div>

        <div className="rounded-lg border border-border/60 bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Lock className="h-4 w-4" aria-hidden />
            Require SSO
          </div>
          <p className="font-medium text-foreground">
            {initialRequireSso ? (
              <span className="text-amber-400">Enabled</span>
            ) : (
              <span className="text-muted-foreground">Disabled</span>
            )}
          </p>
        </div>

        <div className="rounded-lg border border-border/60 bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Users className="h-4 w-4" aria-hidden />
            Auto-enrolled
          </div>
          <p className="text-2xl font-bold text-foreground">{enrolledCount}</p>
        </div>
      </div>

      {/* Settings form */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <h2 className="text-base font-semibold text-foreground mb-1">SSO Domain Configuration</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Users who sign in with Google and whose account belongs to this domain are automatically
          added to your team as members, up to your seat limit.
        </p>

        <div className="space-y-5">
          {/* Domain field */}
          <div className="space-y-2">
            <Label htmlFor="sso-domain" className="text-foreground">
              Google Workspace Domain
            </Label>
            <div className="flex gap-2">
              <Input
                id="sso-domain"
                type="text"
                value={domain}
                onChange={(e) => handleDomainChange(e.target.value)}
                placeholder="example.com"
                disabled={!isOwner || saving}
                aria-describedby={domainError ? 'sso-domain-error' : 'sso-domain-hint'}
                className="flex-1 font-mono bg-secondary/60 border-border/60 text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-500"
              />
              {initialDomain && isOwner && (
                <Button
                  variant="outline"
                  onClick={handleClear}
                  disabled={clearing || saving}
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  aria-label="Clear SSO domain"
                >
                  {clearing ? 'Clearing...' : 'Clear'}
                </Button>
              )}
            </div>
            {domainError ? (
              <p id="sso-domain-error" role="alert" className="text-xs text-red-400">
                {domainError}
              </p>
            ) : (
              <p id="sso-domain-hint" className="text-xs text-muted-foreground">
                Enter your Google Workspace domain (e.g. <code className="font-mono">acme.com</code>).
                Personal Gmail accounts do not carry a domain claim and will not be auto-enrolled.
              </p>
            )}
          </div>

          {/* Require SSO toggle */}
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-secondary/20 p-4">
            <div className="mt-0.5">
              <button
                type="button"
                role="switch"
                aria-checked={requireSso}
                onClick={() => isOwner && handleRequireSsoChange(!requireSso)}
                disabled={!isOwner || saving}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                  requireSso ? 'bg-amber-500' : 'bg-zinc-600'
                }`}
                aria-label="Require Google SSO for all team members"
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                    requireSso ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Require Google SSO</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                When enabled, password and magic-link sign-in are rejected for all team members.
                Only Google Workspace accounts from the configured domain can access this team.
              </p>
              {requireSso && (
                <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
                  Members using password or magic-link sign-in will lose access on their next login.
                </div>
              )}
            </div>
          </div>

          {/* Save message */}
          {saveMessage && (
            <div
              role="alert"
              className={`rounded-lg border p-3 text-sm ${
                saveMessage.type === 'success'
                  ? 'border-green-500/20 bg-green-500/10 text-green-400'
                  : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {saveMessage.text}
            </div>
          )}

          {/* Save button */}
          {isOwner && (
            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={saving || clearing || !!domainError}
                className="bg-amber-500 text-background hover:bg-amber-600 font-medium min-w-[100px]"
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          )}

          {!isOwner && (
            <p className="text-xs text-muted-foreground text-right">
              Only the team owner can change SSO settings.
            </p>
          )}
        </div>
      </div>

      {/* require_sso confirmation dialog */}
      {showSsoConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sso-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" aria-hidden />
              <div>
                <h3 id="sso-confirm-title" className="text-base font-semibold text-foreground">
                  Require Google SSO for {teamName}?
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Enabling this setting will{' '}
                  <strong className="text-foreground">immediately prevent</strong> all team members
                  from using password or magic-link sign-in. They must use Google Sign-In with a
                  <strong className="text-foreground"> {domain || 'configured'}</strong> domain account.
                </p>
                <p className="mt-2 text-sm text-amber-400">
                  Members without Google Workspace accounts on this domain will lose access on their
                  next login. Make sure all members can authenticate via Google before enabling.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => { setShowSsoConfirm(false); }}
                className="border-border/60"
              >
                Cancel
              </Button>
              <Button
                onClick={confirmEnableSso}
                className="bg-amber-500 text-background hover:bg-amber-600"
                aria-describedby="sso-confirm-title"
              >
                Enable Require SSO
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Recent SSO audit events */}
      {recentEvents.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-6">
          <h2 className="text-base font-semibold text-foreground mb-4">Recent SSO Events</h2>
          <div className="space-y-1">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center justify-between py-2 border-b border-border/40 last:border-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AuditActionIcon action={event.action} />
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{auditActionLabel(event.action)}</p>
                    {typeof event.metadata?.email === 'string' && (
                      <p className="text-xs text-muted-foreground truncate font-mono">
                        {event.metadata.email}
                      </p>
                    )}
                    {typeof event.metadata?.reason === 'string' && (
                      <p className="text-xs text-red-400 truncate">
                        Reason: {event.metadata.reason}
                      </p>
                    )}
                  </div>
                </div>
                <time
                  dateTime={event.created_at}
                  className="text-xs text-muted-foreground shrink-0 ml-4"
                >
                  {formatEventDate(event.created_at)}
                </time>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* How it works info box */}
      <div className="rounded-xl border border-border/60 bg-secondary/20 p-6">
        <h2 className="text-base font-semibold text-foreground mb-3">How Google SSO works</h2>
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>A user clicks &quot;Continue with Google&quot; on the login or signup page.</li>
          <li>
            Google signs them in and provides a{' '}
            <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">hd</code> claim
            indicating their Workspace domain.
          </li>
          <li>
            Styrby verifies the <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">hd</code> claim
            matches your configured SSO domain.
          </li>
          <li>If there is a match and seats are available, the user is auto-added as a team member.</li>
          <li>
            If <strong className="text-foreground">Require SSO</strong> is on, users who did not
            authenticate via Google with the matching domain are redirected to the login page.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">
          Manual invitations still work for cross-domain collaborators regardless of SSO settings.
        </p>
      </div>
    </div>
  );
}

