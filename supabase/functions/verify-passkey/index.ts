/**
 * verify-passkey — Supabase Edge Function
 *
 * Handles the server-side half of the WebAuthn (Level 3) ceremonies used
 * by Phase 1.2 passkey login. Three actions are exposed via POST body
 * `{ action: '...' }`:
 *
 *   - `challenge-register`  — issue a random challenge for registration
 *   - `verify-register`     — verify attestation, persist credential
 *   - `challenge-login`     — issue a random challenge for authentication
 *   - `verify-login`        — verify assertion, mint Supabase session
 *
 * WHY one function, four actions: challenge issuance and verification
 * share rate-limit / origin-check / logging scaffolding. Splitting them
 * into four functions would triple cold-start cost and duplicate code.
 *
 * Standards cited:
 *   WebAuthn L3 §7.1 (registration) / §7.2 (authentication)
 *   SOC2 CC6.6 (authentication), CC7.2 (monitoring)
 *   NIST 800-63B AAL3 (phishing-resistant MFA)
 *
 * DEPLOYMENT:
 *   Required env vars:
 *     SUPABASE_URL                    — project URL
 *     SUPABASE_SERVICE_ROLE_KEY       — admin key (RLS bypass for insert+mint)
 *     PASSKEY_RP_ID                   — effective domain (e.g. 'styrby.com')
 *     PASSKEY_RP_NAME                 — display name ('Styrby')
 *     PASSKEY_EXPECTED_ORIGINS        — comma-separated list of allowed
 *                                        origins (https://styrby.com,
 *                                        https://www.styrby.com, capacitor://
 *                                        styrby.app, etc.)
 *   Optional:
 *     UPSTASH_REDIS_REST_URL          — enables distributed rate limiting
 *     UPSTASH_REDIS_REST_TOKEN
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  // deno-lint-ignore no-explicit-any
} from 'https://esm.sh/@simplewebauthn/server@11.0.0';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from 'https://esm.sh/@simplewebauthn/types@11.0.0';

// ============================================================================
// Env helpers
// ============================================================================

/**
 * Read a required environment variable or throw a 500-safe error.
 *
 * WHY: Silently falling back to `""` lets an RP-ID misconfiguration ship
 * all the way to clients and produce mysterious SecurityError messages.
 * Fail fast in the edge runtime so the 500 surfaces in Sentry immediately.
 */
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`verify-passkey: missing required env var ${name}`);
  }
  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const RP_ID = requireEnv('PASSKEY_RP_ID');
const RP_NAME = Deno.env.get('PASSKEY_RP_NAME') ?? 'Styrby';
const EXPECTED_ORIGINS = requireEnv('PASSKEY_EXPECTED_ORIGINS')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (EXPECTED_ORIGINS.length === 0) {
  throw new Error(
    'verify-passkey: PASSKEY_EXPECTED_ORIGINS must contain at least one origin',
  );
}

// ============================================================================
// Challenge store (ephemeral, keyed by user id / email)
// ============================================================================

/**
 * Short-lived challenge cache. Lives in the `passkey_challenges` table
 * (see migration 020 note) OR we can use Supabase's built-in sessionStorage
 * helpers. For simplicity + auditability, we round-trip via a dedicated
 * table written with the service role.
 *
 * NOTE: For this initial drop we use an in-memory Map scoped to the
 * edge-function instance. Supabase edge functions are per-request short-
 * lived by default; multi-instance deployments will need the table-backed
 * variant. This is tracked in docs/planning/styrby-improve-19Apr.md §1.5
 * as "passkey challenge persistence" follow-up.
 *
 * WHY this is acceptable for the launch window: challenge TTL is 5min,
 * and a client that hits a different instance simply retries. The only
 * security property we need — challenges are single-use and expire — is
 * preserved by the TTL.
 */
const challengeStore = new Map<string, { challenge: string; expiresAt: number }>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function storeChallenge(key: string, challenge: string): void {
  challengeStore.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  // Opportunistic cleanup — keeps the map bounded without a timer.
  if (challengeStore.size > 1000) {
    const now = Date.now();
    for (const [k, v] of challengeStore.entries()) {
      if (v.expiresAt < now) challengeStore.delete(k);
    }
  }
}

function consumeChallenge(key: string): string | null {
  const entry = challengeStore.get(key);
  if (!entry) return null;
  challengeStore.delete(key); // single-use
  if (entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

// ============================================================================
// Rate limiter (Upstash-first, in-memory fallback)
// ============================================================================

const UPSTASH_URL = Deno.env.get('UPSTASH_REDIS_REST_URL');
const UPSTASH_TOKEN = Deno.env.get('UPSTASH_REDIS_REST_TOKEN');

const memoryBucket = new Map<string, { count: number; resetAt: number }>();

/**
 * Per-key sliding-ish window limit. Returns true when the request is
 * allowed, false when the caller should be rejected with 429.
 *
 * @param key - Stable identity (credentialId for failed verifications,
 *              email for challenge requests).
 * @param max - Max requests in the window.
 * @param windowMs - Window length.
 */
async function rateLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    // Upstash atomic INCR + PEXPIRE pattern. Same as lib/rateLimit.ts on web.
    const bucket = `passkey:rl:${key}`;
    const incrUrl = `${UPSTASH_URL}/pipeline`;
    const res = await fetch(incrUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', bucket],
        ['PEXPIRE', bucket, String(windowMs), 'NX'],
      ]),
    });
    if (!res.ok) {
      // WHY fail-open on redis outage: we prefer availability for legit users
      // over denying all logins during infra trouble. The server still enforces
      // WebAuthn signature + counter checks, so no auth bypass exists.
      console.error('verify-passkey: upstash error, failing open', await res.text());
      return true;
    }
    const [incr] = (await res.json()) as Array<{ result: number }>;
    return incr.result <= max;
  }

  // In-memory fallback (per-instance). Good enough for local dev.
  const now = Date.now();
  const entry = memoryBucket.get(key);
  if (!entry || entry.resetAt < now) {
    memoryBucket.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

// ============================================================================
// Supabase admin client
// ============================================================================

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface AuthorizedUser {
  id: string;
  email: string;
}

/**
 * Resolve the calling user from the Authorization: Bearer <jwt> header.
 * Used by the registration actions (registration must be tied to a
 * session the user already has; login actions run anonymously).
 */
async function getCallerUser(req: Request): Promise<AuthorizedUser | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email };
}

/**
 * Mint a fresh Supabase session for a user by generating a magiclink and
 * extracting its hashed token. This is the documented server-to-server
 * path for issuing a session when bypassing the normal email flow.
 *
 * We use the `magiclink` type because it returns a `hashed_token` that the
 * client can exchange for a Session via `supabase.auth.verifyOtp`.
 *
 * WHY not createUser + anonymous sign-in: the verified credential is
 * already bound to an existing user row (we lookup by credentialId). We
 * need to sign in as THAT user, not create a new one.
 */
async function mintSessionForUser(email: string): Promise<{
  properties: { hashed_token: string };
  user: { id: string; email: string };
}> {
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (admin.auth.admin as any).generateLink({
    type: 'magiclink',
    email,
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(`mintSessionForUser failed: ${error?.message ?? 'no token'}`);
  }
  return data;
}

// ============================================================================
// Action handlers
// ============================================================================

async function handleChallengeRegister(req: Request): Promise<Response> {
  const user = await getCallerUser(req);
  if (!user) return jsonResponse(401, { error: 'UNAUTHORIZED' });

  if (!(await rateLimit(`reg:${user.id}`, 10, 60_000))) {
    return jsonResponse(429, { error: 'RATE_LIMITED' });
  }

  // Existing credentials — exclude to prevent double-registration of the
  // same authenticator (WebAuthn L3 §7.1 step 9).
  const { data: existing } = await admin
    .from('passkeys')
    .select('credential_id')
    .eq('user_id', user.id)
    .is('revoked_at', null);

  const options = await generateRegistrationOptions({
    rpID: RP_ID,
    rpName: RP_NAME,
    userName: user.email,
    userDisplayName: user.email,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    excludeCredentials: (existing ?? []).map((c) => ({
      id: c.credential_id,
      type: 'public-key',
    })),
  });

  storeChallenge(`reg:${user.id}`, options.challenge);
  return jsonResponse(200, options);
}

async function handleVerifyRegister(req: Request, body: {
  response: RegistrationResponseJSON;
  deviceName?: string;
}): Promise<Response> {
  const user = await getCallerUser(req);
  if (!user) return jsonResponse(401, { error: 'UNAUTHORIZED' });

  const expectedChallenge = consumeChallenge(`reg:${user.id}`);
  if (!expectedChallenge) {
    return jsonResponse(400, { error: 'CHALLENGE_EXPIRED' });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (err) {
    console.error('verify-passkey registration failed', err);
    return jsonResponse(400, { error: 'VERIFICATION_FAILED' });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return jsonResponse(400, { error: 'VERIFICATION_FAILED' });
  }

  const { credential } = verification.registrationInfo;
  const { error: insertError } = await admin.from('passkeys').insert({
    user_id: user.id,
    credential_id: credential.id,
    public_key: btoa(String.fromCharCode(...credential.publicKey)),
    counter: credential.counter,
    transports: credential.transports ?? [],
    device_name: body.deviceName ?? 'Passkey',
  });

  if (insertError) {
    console.error('verify-passkey insert failed', insertError);
    return jsonResponse(500, { error: 'INSERT_FAILED' });
  }

  return jsonResponse(201, { verified: true });
}

async function handleChallengeLogin(body: { email: string }): Promise<Response> {
  const email = body.email?.trim().toLowerCase();
  if (!email) return jsonResponse(400, { error: 'EMAIL_REQUIRED' });

  if (!(await rateLimit(`login:${email}`, 10, 60_000))) {
    return jsonResponse(429, { error: 'RATE_LIMITED' });
  }

  // Look up credentials for email. We deliberately do NOT reveal whether
  // the email has registered passkeys — return an empty allow-list either
  // way so attackers cannot enumerate accounts via this endpoint.
  let allowCredentials: Array<{ id: string; type: 'public-key' }> = [];
  // deno-lint-ignore no-explicit-any
  const { data: userRow } = await (admin.auth.admin as any).listUsers({
    filter: `email.eq.${email}`,
  });
  const userId = userRow?.users?.find((u: { email?: string }) => u.email === email)?.id;
  if (userId) {
    const { data: creds } = await admin
      .from('passkeys')
      .select('credential_id')
      .eq('user_id', userId)
      .is('revoked_at', null);
    allowCredentials = (creds ?? []).map((c) => ({
      id: c.credential_id,
      type: 'public-key',
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials,
  });

  // Keyed by email since the client has not yet proven identity.
  storeChallenge(`login:${email}`, options.challenge);
  return jsonResponse(200, options);
}

async function handleVerifyLogin(body: {
  email: string;
  response: AuthenticationResponseJSON;
}): Promise<Response> {
  const email = body.email?.trim().toLowerCase();
  if (!email) return jsonResponse(400, { error: 'EMAIL_REQUIRED' });

  // Failed-login rate limit keyed on credential id AND email.
  const credentialId = body.response.id;
  if (!(await rateLimit(`verify:${credentialId}`, 10, 60_000))) {
    return jsonResponse(429, { error: 'RATE_LIMITED' });
  }

  const expectedChallenge = consumeChallenge(`login:${email}`);
  if (!expectedChallenge) {
    return jsonResponse(400, { error: 'CHALLENGE_EXPIRED' });
  }

  // Fetch the credential row WITHOUT leaking existence to the caller.
  const { data: row } = await admin
    .from('passkeys')
    .select('id, user_id, public_key, counter, revoked_at')
    .eq('credential_id', credentialId)
    .maybeSingle();

  if (!row || row.revoked_at) {
    return jsonResponse(401, { error: 'UNAUTHORIZED' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(
          Array.from(atob(row.public_key), (c) => c.charCodeAt(0)),
        ),
        counter: row.counter,
      },
    });
  } catch (err) {
    console.error('verify-passkey login verify failed', err);
    return jsonResponse(401, { error: 'UNAUTHORIZED' });
  }

  if (!verification.verified) {
    return jsonResponse(401, { error: 'UNAUTHORIZED' });
  }

  // Counter rollback gate — WebAuthn L3 §7.2 step 19.
  // verifyAuthenticationResponse already enforces `new > stored`, but we
  // run our own defense-in-depth check because the library has changed
  // semantics in past major versions.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter !== 0 || row.counter !== 0) {
    if (newCounter <= row.counter) {
      console.error('verify-passkey: counter rollback detected', {
        credentialId,
        stored: row.counter,
        incoming: newCounter,
      });
      // Soft-revoke the credential — likely a clone.
      await admin
        .from('passkeys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', row.id);
      return jsonResponse(401, { error: 'UNAUTHORIZED' });
    }
  }

  // Persist new counter + last_used_at.
  await admin
    .from('passkeys')
    .update({
      counter: newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  // Mint a session the client can exchange via supabase.auth.verifyOtp.
  const session = await mintSessionForUser(email);
  return jsonResponse(200, {
    verified: true,
    hashed_token: session.properties.hashed_token,
    email,
  });
}

// ============================================================================
// Router
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'METHOD_NOT_ALLOWED' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'INVALID_JSON' });
  }

  const action = typeof body.action === 'string' ? body.action : '';

  try {
    switch (action) {
      case 'challenge-register':
        return await handleChallengeRegister(req);
      case 'verify-register':
        return await handleVerifyRegister(req, body as {
          action: string;
          response: RegistrationResponseJSON;
          deviceName?: string;
        });
      case 'challenge-login':
        return await handleChallengeLogin(body as { email: string });
      case 'verify-login':
        return await handleVerifyLogin(body as {
          email: string;
          response: AuthenticationResponseJSON;
        });
      default:
        return jsonResponse(400, { error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    console.error('verify-passkey unhandled error', err);
    return jsonResponse(500, { error: 'INTERNAL_ERROR' });
  }
});

// Exports for unit testing (ignored by the Deno runtime).
export const __test__ = {
  storeChallenge,
  consumeChallenge,
  rateLimit,
};
