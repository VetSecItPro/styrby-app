/**
 * Browser OAuth Authentication with PKCE
 *
 * Handles browser-based OAuth flow for Supabase Auth with PKCE security.
 * Supports GitHub OAuth and Magic Link (email) authentication methods.
 *
 * @module auth/browser-auth
 */

import * as crypto from 'node:crypto';
import open from 'open';
import { logger } from '@/ui/logger';
import { startAuthCallbackServer, type AuthCallbackResult } from './local-server';

// ============================================================================
// Types
// ============================================================================

/**
 * PKCE (Proof Key for Code Exchange) data for OAuth security
 */
export interface PKCEData {
  /** Random verifier string (kept secret) */
  verifier: string;
  /** SHA-256 hash of verifier, base64url encoded */
  challenge: string;
  /** Challenge method (always S256 for SHA-256) */
  method: 'S256';
}

/**
 * Supported OAuth providers
 */
export type OAuthProvider = 'github';

/**
 * Authentication method selection
 */
export type AuthMethod = 'github' | 'email';

/**
 * Options for starting browser authentication
 */
export interface BrowserAuthOptions {
  /** Supabase project URL */
  supabaseUrl: string;
  /** OAuth provider to use */
  provider?: OAuthProvider;
  /** Auth method (github or email) */
  method?: AuthMethod;
  /** Email address for magic link (required if method is 'email') */
  email?: string;
  /** Timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number;
  /** Whether to skip opening browser (for testing) */
  skipBrowser?: boolean;
}

/**
 * Successful authentication result
 */
export interface AuthResult {
  /** Supabase access token */
  accessToken: string;
  /** Supabase refresh token */
  refreshToken: string;
  /** Token expiration time (seconds from now) */
  expiresIn: number;
  /** Token type (always 'bearer') */
  tokenType: string;
  /** User information */
  user: {
    id: string;
    email?: string;
    name?: string;
    avatarUrl?: string;
  };
}

/**
 * Authentication error types
 */
export type AuthErrorType =
  | 'timeout'
  | 'cancelled'
  | 'invalid_code'
  | 'network_error'
  | 'server_error';

/**
 * Authentication error
 */
export class AuthError extends Error {
  constructor(
    public readonly type: AuthErrorType,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ============================================================================
// PKCE Generation
// ============================================================================

/**
 * Generate PKCE code verifier and challenge for OAuth security.
 *
 * The verifier is a cryptographically random string that the client keeps secret.
 * The challenge is the SHA-256 hash of the verifier, sent to the auth server.
 * This prevents authorization code interception attacks.
 *
 * @returns PKCE data with verifier, challenge, and method
 *
 * @example
 * const pkce = generatePKCE();
 * // pkce.verifier: keep secret, use when exchanging code
 * // pkce.challenge: send to auth server in authorize request
 */
export function generatePKCE(): PKCEData {
  // Generate 32 random bytes (256 bits of entropy)
  const verifierBytes = crypto.randomBytes(32);

  // Encode as base64url (URL-safe base64 without padding)
  const verifier = verifierBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Create SHA-256 hash of verifier
  const hash = crypto.createHash('sha256').update(verifier).digest();

  // Encode hash as base64url
  const challenge = hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return {
    verifier,
    challenge,
    method: 'S256',
  };
}

/**
 * Generate a random state parameter for CSRF protection.
 *
 * @returns Random state string
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// ============================================================================
// Auth URL Building
// ============================================================================

/**
 * Build the Supabase OAuth authorization URL.
 *
 * @param supabaseUrl - Supabase project URL
 * @param redirectUri - Local callback URI (e.g., http://127.0.0.1:52280/callback)
 * @param pkce - PKCE data
 * @param state - State parameter for CSRF protection
 * @param provider - OAuth provider (optional, defaults to Supabase's auth UI)
 * @returns Authorization URL to open in browser
 */
export function buildAuthUrl(
  supabaseUrl: string,
  redirectUri: string,
  pkce: PKCEData,
  state: string,
  provider?: OAuthProvider
): string {
  const params = new URLSearchParams({
    redirect_to: redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    state,
  });

  if (provider) {
    params.set('provider', provider);
  }

  // Supabase auth endpoint
  return `${supabaseUrl}/auth/v1/authorize?${params.toString()}`;
}

/**
 * Build the Supabase token exchange URL.
 *
 * @param supabaseUrl - Supabase project URL
 * @returns Token exchange URL
 */
export function buildTokenUrl(supabaseUrl: string): string {
  return `${supabaseUrl}/auth/v1/token`;
}

// ============================================================================
// Token Exchange
// ============================================================================

/**
 * Exchange authorization code for tokens.
 *
 * @param supabaseUrl - Supabase project URL
 * @param code - Authorization code from callback
 * @param verifier - PKCE verifier (kept secret during auth flow)
 * @param redirectUri - Same redirect URI used in authorize request
 * @returns Authentication result with tokens and user info
 * @throws AuthError if token exchange fails
 */
export async function exchangeCodeForTokens(
  supabaseUrl: string,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<AuthResult> {
  const tokenUrl = buildTokenUrl(supabaseUrl);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.debug('Token exchange failed', { status: response.status, error: errorText });
      throw new AuthError(
        'invalid_code',
        `Token exchange failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      user?: {
        id: string;
        email?: string;
        user_metadata?: {
          full_name?: string;
          name?: string;
          avatar_url?: string;
        };
      };
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      user: {
        id: data.user?.id || '',
        email: data.user?.email,
        name: data.user?.user_metadata?.full_name || data.user?.user_metadata?.name,
        avatarUrl: data.user?.user_metadata?.avatar_url,
      },
    };
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(
      'network_error',
      'Failed to exchange authorization code for tokens',
      error
    );
  }
}

// ============================================================================
// Main Auth Flow
// ============================================================================

/**
 * Start browser-based OAuth authentication flow.
 *
 * This function:
 * 1. Generates PKCE code verifier and challenge
 * 2. Starts a local callback server
 * 3. Opens browser to Supabase auth URL
 * 4. Waits for callback with authorization code
 * 5. Exchanges code for tokens
 * 6. Returns authenticated session
 *
 * @param options - Authentication options
 * @returns Authentication result with tokens and user info
 * @throws AuthError if authentication fails
 *
 * @example
 * const result = await startBrowserAuth({
 *   supabaseUrl: 'https://xxx.supabase.co',
 *   provider: 'github',
 * });
 * console.log('Logged in as:', result.user.email);
 */
export async function startBrowserAuth(options: BrowserAuthOptions): Promise<AuthResult> {
  const { supabaseUrl, provider = 'github', timeout = 120000, skipBrowser = false } = options;

  // Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  logger.debug('Starting browser auth', { provider, supabaseUrl });

  // Start local callback server
  const server = await startAuthCallbackServer({ timeout });
  const redirectUri = server.callbackUrl;

  logger.debug('Callback server started', { redirectUri, port: server.port });

  // Build auth URL
  const authUrl = buildAuthUrl(supabaseUrl, redirectUri, pkce, state, provider);

  // Open browser (unless skipped for testing)
  if (!skipBrowser) {
    logger.info('Opening browser for authentication...');
    console.log('\n  Please sign in with your Styrby account.\n');

    try {
      await open(authUrl);
    } catch (error) {
      // Browser open failed, display URL for manual copy
      console.log('  Could not open browser automatically.');
      console.log('  Please open this URL manually:\n');
      console.log(`  ${authUrl}\n`);
    }
  }

  // Wait for callback
  let callbackResult: AuthCallbackResult;
  try {
    callbackResult = await server.waitForCallback();
  } finally {
    // Always close the server
    await server.close();
  }

  // Validate state to prevent CSRF
  if (callbackResult.state !== state) {
    throw new AuthError(
      'server_error',
      'State mismatch - possible CSRF attack or stale auth flow'
    );
  }

  // Check for errors in callback
  if (callbackResult.error) {
    throw new AuthError(
      'server_error',
      `Authentication failed: ${callbackResult.error} - ${callbackResult.errorDescription || 'Unknown error'}`
    );
  }

  if (!callbackResult.code) {
    throw new AuthError('server_error', 'No authorization code received');
  }

  logger.debug('Received authorization code, exchanging for tokens');

  // Exchange code for tokens
  const result = await exchangeCodeForTokens(
    supabaseUrl,
    callbackResult.code,
    pkce.verifier,
    redirectUri
  );

  logger.debug('Authentication successful', { userId: result.user.id });

  return result;
}

/**
 * Default export for module
 */
export default {
  generatePKCE,
  generateState,
  buildAuthUrl,
  buildTokenUrl,
  exchangeCodeForTokens,
  startBrowserAuth,
  AuthError,
};
