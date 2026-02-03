/**
 * Styrby Pairing Flow
 *
 * Handles QR code-based pairing between CLI and mobile app.
 *
 * Flow:
 * 1. CLI generates a pairing token (short-lived, single-use)
 * 2. CLI displays token as QR code
 * 3. Mobile scans QR code and extracts pairing info
 * 4. Mobile uses token to authenticate and get user session
 * 5. Both devices connect to the same Realtime channel
 */

import type { AgentType } from '../types.js';

// ============================================================================
// Pairing Token Types
// ============================================================================

/**
 * Information encoded in the pairing QR code
 */
export interface PairingPayload {
  /** Version of the pairing protocol */
  version: 1;
  /** Pairing token (short-lived, single-use) */
  token: string;
  /** User ID */
  userId: string;
  /** Machine ID of the CLI */
  machineId: string;
  /** CLI device name */
  deviceName: string;
  /** Current active agent (if any) */
  activeAgent?: AgentType;
  /** Supabase project URL (for multi-environment support) */
  supabaseUrl: string;
  /** Token expiration timestamp (ISO) */
  expiresAt: string;
}

/**
 * Pairing state stored in database
 */
export interface PairingSession {
  /** Unique pairing session ID */
  id: string;
  /** User ID */
  userId: string;
  /** Machine ID that initiated pairing */
  machineId: string;
  /** Hashed pairing token */
  tokenHash: string;
  /** Whether pairing has been completed */
  completed: boolean;
  /** Mobile device ID that completed pairing (if completed) */
  pairedDeviceId?: string;
  /** Creation timestamp */
  createdAt: string;
  /** Expiration timestamp */
  expiresAt: string;
}

/**
 * Result of pairing attempt
 */
export interface PairingResult {
  success: boolean;
  error?: string;
  userId?: string;
  machineId?: string;
  deviceName?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Pairing token expiration time (5 minutes) */
export const PAIRING_TOKEN_EXPIRY_MS = 5 * 60 * 1000;

/** QR code deep link scheme */
export const PAIRING_SCHEME = 'styrby://pair';

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generate a cryptographically secure pairing token
 */
export function generatePairingToken(): string {
  // Generate 32 random bytes and encode as base64url
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Hash a pairing token for storage (using SHA-256)
 */
export async function hashPairingToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// QR Code Data Encoding
// ============================================================================

/**
 * Create a pairing payload for QR code
 */
export function createPairingPayload(
  token: string,
  userId: string,
  machineId: string,
  deviceName: string,
  supabaseUrl: string,
  activeAgent?: AgentType
): PairingPayload {
  return {
    version: 1,
    token,
    userId,
    machineId,
    deviceName,
    activeAgent,
    supabaseUrl,
    expiresAt: new Date(Date.now() + PAIRING_TOKEN_EXPIRY_MS).toISOString(),
  };
}

/**
 * Encode pairing payload as a deep link URL for QR code
 */
export function encodePairingUrl(payload: PairingPayload): string {
  const data = btoa(JSON.stringify(payload));
  return `${PAIRING_SCHEME}?data=${encodeURIComponent(data)}`;
}

/**
 * Decode pairing URL from QR code scan
 */
export function decodePairingUrl(url: string): PairingPayload | null {
  try {
    // Handle both full URL and just the data parameter
    let data: string;

    if (url.startsWith(PAIRING_SCHEME)) {
      const urlObj = new URL(url);
      data = urlObj.searchParams.get('data') || '';
    } else {
      // Assume it's just the data parameter
      data = url;
    }

    const decoded = JSON.parse(atob(decodeURIComponent(data)));

    // Validate version
    if (decoded.version !== 1) {
      console.error('Unsupported pairing version:', decoded.version);
      return null;
    }

    return decoded as PairingPayload;
  } catch (error) {
    console.error('Failed to decode pairing URL:', error);
    return null;
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Check if a pairing payload has expired
 */
export function isPairingExpired(payload: PairingPayload): boolean {
  return new Date(payload.expiresAt) < new Date();
}

/**
 * Validate pairing payload structure
 */
export function validatePairingPayload(payload: unknown): payload is PairingPayload {
  if (!payload || typeof payload !== 'object') return false;

  const p = payload as Partial<PairingPayload>;

  return (
    p.version === 1 &&
    typeof p.token === 'string' &&
    typeof p.userId === 'string' &&
    typeof p.machineId === 'string' &&
    typeof p.deviceName === 'string' &&
    typeof p.supabaseUrl === 'string' &&
    typeof p.expiresAt === 'string'
  );
}
