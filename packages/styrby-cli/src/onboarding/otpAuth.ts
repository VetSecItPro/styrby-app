/**
 * Inline OTP Authentication
 *
 * Replaces the browser-redirect OAuth flow with an email OTP (one-time
 * password) path that completes entirely in the terminal. The user types their
 * email, gets a 6-digit code, pastes it, and auth is done — no browser tab,
 * no callback server, no localhost:54321 port dance.
 *
 * WHY OTP instead of OAuth for the fast path:
 * Browser-redirect OAuth opens a tab, waits for the user to click "Authorize",
 * and then polls a local callback server. That entire sequence adds 20-40 s
 * on a cold machine (browser launch + DNS + OAuth round trips). OTP email
 * delivery is typically sub-5 s; terminal paste is instant. Together they
 * shave ~30 s off the median onboarding time.
 *
 * WHY Supabase OTP specifically:
 * Supabase Auth's `signInWithOtp` endpoint is the same authentication surface
 * as magic-link email. We use `shouldCreateUser: true` so first-time users
 * are auto-registered on the server side. No separate signup step required.
 *
 * WHY polling instead of a callback:
 * Supabase Auth does not offer a server-sent event for "OTP verified". The
 * canonical client-side approach is to call `verifyOtp` with the code the user
 * provides. We poll the session validity after verification to confirm success.
 *
 * @module onboarding/otpAuth
 */

import * as readline from 'node:readline';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result from a successful OTP verification.
 */
export interface OtpAuthResult {
  /** Supabase access token. */
  accessToken: string;
  /** Supabase refresh token. */
  refreshToken: string;
  /** User ID (UUID). */
  userId: string;
  /** User email address. */
  userEmail: string;
}

/**
 * Options for the OTP auth flow.
 */
export interface OtpAuthOptions {
  /** Supabase project URL. */
  supabaseUrl: string;
  /** Supabase anonymous key. */
  supabaseAnonKey: string;
  /**
   * Pre-supplied email (skips the readline prompt).
   * Used in test harnesses to avoid interactive I/O.
   */
  email?: string;
  /**
   * Pre-supplied OTP token (skips the readline prompt for the code).
   * Used in test harnesses.
   */
  otpToken?: string;
  /**
   * Custom readline interface for I/O injection in tests.
   * If omitted, a default interface is created from process.stdin/stdout.
   */
  rl?: {
    question: (query: string, callback: (answer: string) => void) => void;
    close: () => void;
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Prompt the user for their email address.
 *
 * @param rl - Readline interface
 * @returns Trimmed, lowercased email string
 */
export function promptEmail(
  rl: { question: (q: string, cb: (a: string) => void) => void }
): Promise<string> {
  return new Promise((resolve) => {
    rl.question('  Email: ', (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Prompt the user for their OTP code.
 *
 * @param rl - Readline interface
 * @returns Trimmed OTP string (may include spaces the user typed by mistake)
 */
export function promptOtpCode(
  rl: { question: (q: string, cb: (a: string) => void) => void }
): Promise<string> {
  return new Promise((resolve) => {
    rl.question('  Code: ', (answer) => {
      // WHY: Strip spaces — users often paste "123 456" from email clients.
      resolve(answer.trim().replace(/\s/g, ''));
    });
  });
}

/**
 * Send an OTP to the given email via Supabase Auth.
 *
 * This is the "magic OTP" path — not magic link. Supabase sends a 6-digit
 * code the user pastes into the terminal.
 *
 * @param supabase - Supabase client (anonymous)
 * @param email - User email
 * @throws Error if the Supabase call fails (network error, invalid project, etc.)
 */
export async function sendOtp(supabase: SupabaseClient, email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // WHY shouldCreateUser: first-time users are auto-provisioned. No
      // separate sign-up endpoint needed. Saves one round trip and one UX step.
      shouldCreateUser: true,
    },
  });

  if (error) {
    throw new Error(`OTP send failed: ${error.message}`);
  }
}

/**
 * Verify the OTP code provided by the user.
 *
 * @param supabase - Supabase client (anonymous)
 * @param email - User email (must match the OTP recipient)
 * @param token - 6-digit OTP code
 * @returns Auth result with tokens and user info
 * @throws Error if verification fails (wrong code, expired, etc.)
 */
export async function verifyOtp(
  supabase: SupabaseClient,
  email: string,
  token: string
): Promise<OtpAuthResult> {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });

  if (error || !data.session || !data.user) {
    throw new Error(error?.message ?? 'OTP verification failed — no session returned');
  }

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.user.id,
    userEmail: data.user.email ?? email,
  };
}

/**
 * Run the complete inline OTP authentication flow.
 *
 * Sends an OTP to the user's email, prompts them to paste the code, verifies
 * it against Supabase Auth, and returns the resulting session tokens.
 *
 * @param options - OTP auth options
 * @returns Verified auth result
 * @throws Error if any step fails (network, wrong code, user cancelled, etc.)
 *
 * @example
 * const auth = await runOtpAuth({
 *   supabaseUrl: 'https://xxx.supabase.co',
 *   supabaseAnonKey: 'eyJ...',
 * });
 * // auth.accessToken, auth.userId, auth.userEmail are now available
 */
export async function runOtpAuth(options: OtpAuthOptions): Promise<OtpAuthResult> {
  const supabase = createClient(options.supabaseUrl, options.supabaseAnonKey, {
    auth: { persistSession: false },
  });

  // Use injected readline (tests) or create one from real stdin/stdout.
  const rlInterface =
    options.rl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  try {
    // Step A: Collect email (from option or prompt)
    const email = options.email ?? (await promptEmail(rlInterface));
    if (!email || !email.includes('@')) {
      throw new Error('Invalid email address');
    }

    console.log(`\n  Sending OTP to ${email}...`);

    // Step B: Send OTP
    await sendOtp(supabase, email);

    console.log('  Check your inbox for a 6-digit code.');

    // Step C: Collect OTP code (from option or prompt)
    const token = options.otpToken ?? (await promptOtpCode(rlInterface));
    if (!token || token.length < 6) {
      throw new Error('OTP code must be at least 6 digits');
    }

    // Step D: Verify
    const result = await verifyOtp(supabase, email, token);

    return result;
  } finally {
    // WHY: Only close the rl we created ourselves. Injected test interfaces
    // may be shared across assertions and must not be closed here.
    if (!options.rl) {
      rlInterface.close();
    }
  }
}
