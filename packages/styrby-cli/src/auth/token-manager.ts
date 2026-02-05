/**
 * Token Manager
 *
 * Handles Styrby authentication token lifecycle:
 * - Access token auto-refresh
 * - Refresh token persistence
 * - Session expiration management
 *
 * WHY: Access tokens are short-lived (1 hour) for security.
 * We automatically refresh them in the background so users
 * never see authentication prompts during normal usage.
 *
 * @module auth/token-manager
 */

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { loadPersistedData, savePersistedData, type PersistedData } from '@/persistence';
import { setConfigValue } from '@/configuration';

// ============================================================================
// Types
// ============================================================================

/**
 * Session persistence options
 */
export type SessionPersistence =
  | 'session'   // Until terminal closes (no refresh token stored)
  | '7days'     // 7 days of inactivity
  | '30days'    // 30 days of inactivity (default)
  | '90days';   // 90 days of inactivity

/**
 * Token state
 */
export interface TokenState {
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Access token (short-lived) */
  accessToken?: string;
  /** Refresh token (long-lived) */
  refreshToken?: string;
  /** When access token expires */
  expiresAt?: Date;
  /** User ID */
  userId?: string;
  /** User email */
  userEmail?: string;
  /** Session persistence setting */
  persistence?: SessionPersistence;
}

/**
 * Token refresh result
 */
export interface RefreshResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

import { config } from '@/env';
const SUPABASE_URL = config.supabaseUrl;
const SUPABASE_ANON_KEY = config.supabaseAnonKey;

/**
 * Refresh token before it expires (5 minutes buffer)
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Persistence duration in milliseconds
 */
const PERSISTENCE_DURATION_MS: Record<SessionPersistence, number> = {
  session: 0,  // No persistence
  '7days': 7 * 24 * 60 * 60 * 1000,
  '30days': 30 * 24 * 60 * 60 * 1000,
  '90days': 90 * 24 * 60 * 60 * 1000,
};

// ============================================================================
// Token Manager Class
// ============================================================================

/**
 * Manages authentication token lifecycle.
 *
 * Singleton pattern - use TokenManager.getInstance()
 */
export class TokenManager {
  private static instance: TokenManager;
  private supabase: SupabaseClient | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private state: TokenState = { isAuthenticated: false };

  private constructor() {
    // Load persisted tokens on initialization
    this.loadFromPersistence();
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  /**
   * Get current token state.
   */
  getState(): TokenState {
    return { ...this.state };
  }

  /**
   * Check if user is authenticated with valid tokens.
   */
  isAuthenticated(): boolean {
    if (!this.state.isAuthenticated || !this.state.accessToken) {
      return false;
    }

    // Check if access token is expired
    if (this.state.expiresAt && new Date() >= this.state.expiresAt) {
      // Token expired, but we might be able to refresh
      return !!this.state.refreshToken;
    }

    return true;
  }

  /**
   * Check if tokens need refresh.
   */
  needsRefresh(): boolean {
    if (!this.state.expiresAt || !this.state.refreshToken) {
      return false;
    }

    const now = new Date();
    const expiresAt = new Date(this.state.expiresAt);
    const refreshAt = new Date(expiresAt.getTime() - REFRESH_BUFFER_MS);

    return now >= refreshAt;
  }

  // --------------------------------------------------------------------------
  // Token Operations
  // --------------------------------------------------------------------------

  /**
   * Set tokens after successful authentication.
   *
   * @param tokens - Token data from auth flow
   * @param persistence - Session persistence setting
   */
  setTokens(
    tokens: {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      userId: string;
      userEmail?: string;
    },
    persistence: SessionPersistence = '30days'
  ): void {
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    this.state = {
      isAuthenticated: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
      userId: tokens.userId,
      userEmail: tokens.userEmail,
      persistence,
    };

    // Persist to disk
    this.saveToPersistence();

    // Schedule auto-refresh
    this.scheduleRefresh();

    logger.debug('Tokens set', {
      userId: tokens.userId,
      expiresAt: expiresAt.toISOString(),
      persistence,
    });
  }

  /**
   * Refresh access token using refresh token.
   *
   * @returns Refresh result
   */
  async refresh(): Promise<RefreshResult> {
    if (!this.state.refreshToken) {
      return { success: false, error: 'No refresh token available' };
    }

    logger.debug('Refreshing access token');

    try {
      const supabase = this.getSupabaseClient();

      // Set the session with our refresh token
      const { data, error } = await supabase.auth.setSession({
        access_token: this.state.accessToken || '',
        refresh_token: this.state.refreshToken,
      });

      if (error) {
        logger.debug('Token refresh failed', { error: error.message });

        // If refresh fails, clear tokens and require re-auth
        if (error.message.includes('expired') || error.message.includes('invalid')) {
          this.clearTokens();
        }

        return { success: false, error: error.message };
      }

      if (!data.session) {
        return { success: false, error: 'No session returned' };
      }

      const session = data.session;
      const expiresAt = new Date(session.expires_at! * 1000);

      // Update state
      this.state = {
        ...this.state,
        accessToken: session.access_token,
        refreshToken: session.refresh_token || this.state.refreshToken,
        expiresAt,
      };

      // Persist updated tokens
      this.saveToPersistence();

      // Reschedule refresh
      this.scheduleRefresh();

      logger.debug('Token refreshed successfully', {
        expiresAt: expiresAt.toISOString(),
      });

      return {
        success: true,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.debug('Token refresh error', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Ensure we have a valid access token, refreshing if needed.
   *
   * @returns Valid access token or null if refresh failed
   */
  async ensureValidToken(): Promise<string | null> {
    if (!this.state.accessToken) {
      return null;
    }

    if (this.needsRefresh()) {
      const result = await this.refresh();
      if (!result.success) {
        return null;
      }
      return result.accessToken || null;
    }

    return this.state.accessToken;
  }

  /**
   * Clear all tokens and log out.
   */
  clearTokens(): void {
    this.cancelScheduledRefresh();

    this.state = { isAuthenticated: false };

    // Clear from persistence
    savePersistedData({
      accessToken: undefined,
      refreshToken: undefined,
      authenticatedAt: undefined,
    });

    setConfigValue('authToken', undefined);
    setConfigValue('userId', undefined);

    logger.debug('Tokens cleared');
  }

  // --------------------------------------------------------------------------
  // Supabase Client
  // --------------------------------------------------------------------------

  /**
   * Get an authenticated Supabase client.
   *
   * @returns Supabase client with current access token
   */
  getSupabaseClient(): SupabaseClient {
    if (!this.supabase) {
      this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }

    return this.supabase;
  }

  /**
   * Get an authenticated Supabase client with valid token.
   *
   * @returns Supabase client or null if not authenticated
   */
  async getAuthenticatedClient(): Promise<SupabaseClient | null> {
    const token = await this.ensureValidToken();
    if (!token) {
      return null;
    }

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });

    return client;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * Load tokens from persistent storage.
   */
  private loadFromPersistence(): void {
    const data = loadPersistedData();

    if (data?.accessToken && data?.userId) {
      this.state = {
        isAuthenticated: true,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        userId: data.userId,
        // We don't persist expiresAt, so assume token might need refresh
        expiresAt: undefined,
        persistence: (data as PersistedData & { persistence?: SessionPersistence }).persistence,
      };

      // Schedule a refresh check on next tick
      setImmediate(() => {
        if (this.state.refreshToken) {
          this.refresh().catch(() => {
            // Refresh failed, user will need to re-auth
            logger.debug('Background token refresh failed');
          });
        }
      });
    }
  }

  /**
   * Save tokens to persistent storage.
   */
  private saveToPersistence(): void {
    if (this.state.persistence === 'session') {
      // Don't persist for session-only
      return;
    }

    savePersistedData({
      userId: this.state.userId,
      accessToken: this.state.accessToken,
      refreshToken: this.state.refreshToken,
      authenticatedAt: new Date().toISOString(),
    });

    if (this.state.accessToken) {
      setConfigValue('authToken', this.state.accessToken);
    }
    if (this.state.userId) {
      setConfigValue('userId', this.state.userId);
    }
  }

  // --------------------------------------------------------------------------
  // Auto-Refresh Scheduling
  // --------------------------------------------------------------------------

  /**
   * Schedule automatic token refresh before expiration.
   */
  private scheduleRefresh(): void {
    this.cancelScheduledRefresh();

    if (!this.state.expiresAt || !this.state.refreshToken) {
      return;
    }

    const now = Date.now();
    const expiresAt = this.state.expiresAt.getTime();
    const refreshAt = expiresAt - REFRESH_BUFFER_MS;
    const delay = Math.max(0, refreshAt - now);

    if (delay > 0) {
      this.refreshTimer = setTimeout(() => {
        this.refresh().catch((error) => {
          logger.debug('Scheduled token refresh failed', { error });
        });
      }, delay);

      logger.debug('Token refresh scheduled', {
        refreshIn: Math.round(delay / 1000) + 's',
      });
    }
  }

  /**
   * Cancel any scheduled refresh.
   */
  private cancelScheduledRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get the token manager instance.
 */
export function getTokenManager(): TokenManager {
  return TokenManager.getInstance();
}

/**
 * Check if user is authenticated with valid tokens.
 */
export function isTokenValid(): boolean {
  return getTokenManager().isAuthenticated();
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getValidToken(): Promise<string | null> {
  return getTokenManager().ensureValidToken();
}

/**
 * Get an authenticated Supabase client.
 */
export async function getAuthenticatedSupabase(): Promise<SupabaseClient | null> {
  return getTokenManager().getAuthenticatedClient();
}

/**
 * Default export
 */
export default {
  TokenManager,
  getTokenManager,
  isTokenValid,
  getValidToken,
  getAuthenticatedSupabase,
};
