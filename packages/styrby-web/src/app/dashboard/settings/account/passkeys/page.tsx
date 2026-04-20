'use client';

/**
 * Passkeys Settings Page
 *
 * Lets authenticated users manage their WebAuthn passkeys:
 *   - View all registered passkeys (device name, created date, last used, active/revoked)
 *   - Enroll a new passkey via the browser's WebAuthn API
 *   - Rename a passkey (UPDATE device_name)
 *   - Revoke a passkey (soft delete: UPDATE revoked_at = now())
 *
 * WHY soft delete for revocation:
 * Hard deletion would lose the audit trail. If a credential is later
 * presented after revocation, the server needs the row to exist (with
 * revoked_at set) to reject it with the right error. RLS restricts
 * SELECT/UPDATE to own rows; the edge function uses service role for INSERT.
 * (SOC2 CC6.6, CC7.2)
 *
 * WHY enrollment happens here and not only on login:
 * First-time passkey setup must happen in an authenticated context so we
 * can tie the credential to a verified user ID. The login page's passkey
 * button is for users who have already enrolled. New users enroll here.
 *
 * @module app/dashboard/settings/account/passkeys/page
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { startRegistration } from '@simplewebauthn/browser';
import { KeyRound, Plus, Trash2, Pencil, Check, X, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
// PasskeyCredential type is available via @styrby/shared but not directly
// used in this component — the DB shape (PasskeyRow) is used instead for
// direct Supabase query compatibility. Keeping this comment as a reference
// for future typed API layer integration.

// ============================================================================
// Types
// ============================================================================

/**
 * Passkey row as returned by the Supabase RLS SELECT.
 * Mirrors PasskeyCredential but with snake_case to match DB column names.
 */
interface PasskeyRow {
  id: string;
  credential_id: string;
  device_name: string;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// ============================================================================
// PasskeyCard component
// ============================================================================

interface PasskeyCardProps {
  passkey: PasskeyRow;
  onRevoke: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}

/**
 * Renders a single passkey row with rename and revoke controls.
 *
 * @param passkey - The passkey row from Supabase
 * @param onRevoke - Callback to revoke this passkey
 * @param onRename - Callback to rename this passkey
 */
function PasskeyCard({ passkey, onRevoke, onRename }: PasskeyCardProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.device_name);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const isRevoked = passkey.revoked_at !== null;

  /**
   * Saves the renamed device label.
   */
  async function handleSave() {
    if (!name.trim() || name === passkey.device_name) {
      setEditing(false);
      setName(passkey.device_name);
      return;
    }
    setSaving(true);
    await onRename(passkey.id, name.trim());
    setSaving(false);
    setEditing(false);
  }

  /**
   * Initiates soft-revocation with an inline confirmation state.
   */
  async function handleRevoke() {
    setRevoking(true);
    await onRevoke(passkey.id);
    setRevoking(false);
  }

  return (
    <div
      className={`flex items-center gap-4 rounded-lg border p-4 transition-opacity ${
        isRevoked ? 'opacity-50 border-border/30' : 'border-border/60'
      }`}
    >
      {/* Icon */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
        <KeyRound className="h-5 w-5 text-amber-500" aria-hidden="true" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-sm bg-secondary/60 border-border/60 focus-visible:ring-amber-500"
              maxLength={80}
              autoFocus
              aria-label="Passkey device name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') { setEditing(false); setName(passkey.device_name); }
              }}
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-green-400 hover:text-green-300"
              aria-label="Save name"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              onClick={() => { setEditing(false); setName(passkey.device_name); }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Cancel rename"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{passkey.device_name}</p>
            {isRevoked && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
                Revoked
              </span>
            )}
          </div>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">
          Added {new Date(passkey.created_at).toLocaleDateString()}
          {passkey.last_used_at &&
            ` - Last used ${new Date(passkey.last_used_at).toLocaleDateString()}`}
        </p>
      </div>

      {/* Actions — only for active passkeys */}
      {!isRevoked && !editing && (
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={`Rename passkey ${passkey.device_name}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={handleRevoke}
            disabled={revoking}
            className="text-muted-foreground hover:text-red-400 transition-colors"
            aria-label={`Revoke passkey ${passkey.device_name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main page
// ============================================================================

/**
 * PasskeysPage — settings sub-page for passkey management.
 *
 * Protected: the dashboard layout already enforces authentication, so we
 * skip a redundant auth check here.
 *
 * @returns React element
 */
export default function PasskeysPage() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [fetching, setFetching] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const supabase = createClient();

  /**
   * Fetches all passkeys for the current user.
   * RLS ensures only the authenticated user's rows are returned.
   */
  const fetchPasskeys = useCallback(async () => {
    setFetching(true);
    const { data, error } = await supabase
      .from('passkeys')
      .select(
        'id, credential_id, device_name, transports, created_at, last_used_at, revoked_at',
      )
      .order('created_at', { ascending: false });

    if (error) {
      setStatusMessage({ type: 'error', text: 'Failed to load passkeys.' });
    } else {
      setPasskeys((data as PasskeyRow[]) ?? []);
    }
    setFetching(false);
  }, [supabase]);

  useEffect(() => {
    fetchPasskeys();
  }, [fetchPasskeys]);

  /**
   * Enrollment flow.
   *
   * 1. Request a registration challenge from the edge function.
   * 2. Invoke navigator.credentials.create() via @simplewebauthn/browser.
   * 3. POST the attestation to verify-register.
   * 4. Refresh the passkey list on success.
   *
   * WHY we send the user's session to challenge-register:
   * The edge function needs to know the user's ID and email to build the
   * PublicKeyCredentialCreationOptions (user.id, user.name). It reads these
   * from the Supabase JWT provided via the Authorization header forwarded by
   * the proxy route. Without a valid session, it returns 401.
   */
  async function handleEnroll() {
    setEnrolling(true);
    setStatusMessage(null);

    try {
      // Obtain a short-lived session token for the Authorization header.
      // WHY: The proxy route forwards this to the edge function for user
      // identification during registration challenge issuance.
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      // 1. Get registration challenge
      const challengeRes = await fetch('/api/auth/passkey/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ action: 'challenge-register' }),
      });

      if (!challengeRes.ok) {
        const err = await challengeRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Failed to get registration challenge');
      }

      const challengeData = await challengeRes.json();

      // 2. Invoke browser WebAuthn API
      const attestationResponse = await startRegistration({ optionsJSON: challengeData });

      // 3. Verify and store the credential
      const verifyRes = await fetch('/api/auth/passkey/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          action: 'verify-register',
          response: attestationResponse,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Passkey registration failed');
      }

      setStatusMessage({ type: 'success', text: 'Passkey added successfully.' });
      await fetchPasskeys();
    } catch (err) {
      if (err instanceof Error) {
        // NotAllowedError = user cancelled or already registered (excludeCredentials)
        if (err.name === 'NotAllowedError') {
          setStatusMessage({
            type: 'error',
            text: 'Registration cancelled. Try again or use a different device.',
          });
        } else if (err.name === 'InvalidStateError') {
          setStatusMessage({
            type: 'error',
            text: 'This passkey is already registered.',
          });
        } else {
          setStatusMessage({ type: 'error', text: err.message });
        }
      } else {
        setStatusMessage({ type: 'error', text: 'Failed to add passkey. Try again.' });
      }
    } finally {
      setEnrolling(false);
    }
  }

  /**
   * Soft-revokes a passkey by setting revoked_at to now().
   *
   * @param id - UUID of the passkey row to revoke
   */
  async function handleRevoke(id: string) {
    const { error } = await supabase
      .from('passkeys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      setStatusMessage({ type: 'error', text: 'Failed to revoke passkey.' });
    } else {
      setStatusMessage({ type: 'success', text: 'Passkey revoked.' });
      setPasskeys((prev) =>
        prev.map((p) => (p.id === id ? { ...p, revoked_at: new Date().toISOString() } : p)),
      );
    }
  }

  /**
   * Renames a passkey's device_name label.
   *
   * @param id - UUID of the passkey row
   * @param name - New display name (max 80 chars, enforced by DB check)
   */
  async function handleRename(id: string, name: string) {
    const { error } = await supabase
      .from('passkeys')
      .update({ device_name: name })
      .eq('id', id);

    if (error) {
      setStatusMessage({ type: 'error', text: 'Failed to rename passkey.' });
    } else {
      setPasskeys((prev) => prev.map((p) => (p.id === id ? { ...p, device_name: name } : p)));
    }
  }

  const activePasskeys = passkeys.filter((p) => !p.revoked_at);
  const revokedPasskeys = passkeys.filter((p) => p.revoked_at);

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-amber-500" aria-hidden="true" />
          Passkeys
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Passkeys let you sign in with biometrics (Face ID, Touch ID, Windows Hello) or your
          device PIN. They are phishing-resistant and work across all your devices.
        </p>
      </div>

      {/* Status message */}
      {statusMessage && (
        <div
          role="alert"
          className={`rounded-lg border p-4 text-sm ${
            statusMessage.type === 'success'
              ? 'border-green-500/20 bg-green-500/10 text-green-400'
              : 'border-red-500/20 bg-red-500/10 text-red-400'
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Add passkey */}
      <Button
        onClick={handleEnroll}
        disabled={enrolling}
        className="gap-2 bg-amber-500 text-background hover:bg-amber-600"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {enrolling ? 'Follow the prompt...' : 'Add a passkey'}
      </Button>

      {/* Active passkeys */}
      <section aria-label="Active passkeys">
        {fetching ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            Loading passkeys...
          </div>
        ) : activePasskeys.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 p-6 text-center">
            <KeyRound className="mx-auto mb-2 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No passkeys registered yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a passkey above to enable biometric sign-in.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {activePasskeys.map((pk) => (
              <PasskeyCard
                key={pk.id}
                passkey={pk}
                onRevoke={handleRevoke}
                onRename={handleRename}
              />
            ))}
          </div>
        )}
      </section>

      {/* Revoked passkeys (collapsed) */}
      {revokedPasskeys.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors">
            {revokedPasskeys.length} revoked passkey{revokedPasskeys.length !== 1 ? 's' : ''}
          </summary>
          <div className="mt-3 space-y-3 opacity-60">
            {revokedPasskeys.map((pk) => (
              <PasskeyCard
                key={pk.id}
                passkey={pk}
                onRevoke={handleRevoke}
                onRename={handleRename}
              />
            ))}
          </div>
        </details>
      )}

      {/* Cross-device notice */}
      <p className="text-xs text-muted-foreground border-t border-border/30 pt-4">
        Passkeys are synced by your device&apos;s platform (iCloud Keychain, Google Password Manager,
        Windows Hello). Revoking removes access immediately - even on devices you haven&apos;t
        signed out from.
      </p>
    </div>
  );
}
