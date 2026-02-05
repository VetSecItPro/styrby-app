/**
 * Machine Registration
 *
 * Handles registration of CLI instances with Supabase.
 * Creates a unique machine fingerprint and registers it in the machines table.
 *
 * WHY: Each CLI instance needs a unique identifier for:
 * - Secure pairing with mobile devices
 * - Session tracking across multiple machines
 * - Push notification routing
 *
 * @module auth/machine-registration
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Machine information
 */
export interface MachineInfo {
  /** Unique machine ID (UUID) */
  machineId: string;
  /** Machine fingerprint (SHA-256 hash) */
  fingerprint: string;
  /** Human-readable machine name */
  machineName: string;
  /** Platform (darwin, linux, windows) */
  platform: string;
  /** Platform version */
  platformVersion: string;
}

/**
 * Machine registration result
 */
export interface RegistrationResult {
  /** Whether this is a new registration or existing machine */
  isNew: boolean;
  /** Machine information */
  machine: MachineInfo;
  /** Registration timestamp */
  registeredAt: string;
}

/**
 * Machine registration error
 */
export class MachineRegistrationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MachineRegistrationError';
  }
}

// ============================================================================
// Machine Fingerprint
// ============================================================================

/**
 * Generate a stable machine fingerprint.
 *
 * The fingerprint is a SHA-256 hash of machine-specific attributes:
 * - Hostname
 * - Username
 * - Platform
 * - Home directory
 *
 * This creates a stable identifier that persists across CLI restarts
 * but is unique per user account on the machine.
 *
 * @returns Machine fingerprint as hex string
 *
 * @example
 * const fingerprint = generateMachineFingerprint();
 * // '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069'
 */
export function generateMachineFingerprint(): string {
  const components = [
    os.hostname(),
    os.userInfo().username,
    process.platform,
    os.homedir(),
  ].join(':');

  return crypto.createHash('sha256').update(components).digest('hex');
}

/**
 * Generate a new machine ID (UUID v4).
 *
 * @returns Random UUID
 */
export function generateMachineId(): string {
  return crypto.randomUUID();
}

/**
 * Get machine name (hostname).
 *
 * @returns Human-readable machine name
 */
export function getMachineName(): string {
  return os.hostname();
}

/**
 * Get platform information.
 *
 * @returns Platform string (darwin, linux, windows)
 */
export function getPlatform(): string {
  return process.platform;
}

/**
 * Get platform version.
 *
 * @returns OS release version
 */
export function getPlatformVersion(): string {
  return os.release();
}

// ============================================================================
// Machine Registration
// ============================================================================

/**
 * Register this machine with Supabase.
 *
 * Creates or updates a machine entry in the `machines` table.
 * Uses the fingerprint as a conflict key to handle re-registration
 * of the same machine (e.g., after reinstall).
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - User ID from authentication
 * @param existingMachineId - Existing machine ID to use (optional)
 * @returns Registration result with machine info
 * @throws MachineRegistrationError if registration fails
 *
 * @example
 * const result = await registerMachine(supabase, userId);
 * console.log('Registered machine:', result.machine.machineId);
 */
export async function registerMachine(
  supabase: SupabaseClient,
  userId: string,
  existingMachineId?: string
): Promise<RegistrationResult> {
  const fingerprint = generateMachineFingerprint();
  const machineName = getMachineName();
  const platform = getPlatform();
  const platformVersion = getPlatformVersion();

  logger.debug('Registering machine', {
    fingerprint: fingerprint.slice(0, 16) + '...',
    machineName,
    platform,
  });

  try {
    // Check if machine with this fingerprint already exists for this user
    const { data: existing, error: selectError } = await supabase
      .from('machines')
      .select('id, fingerprint, name, platform, created_at')
      .eq('user_id', userId)
      .eq('fingerprint', fingerprint)
      .single();

    if (selectError && selectError.code !== 'PGRST116') {
      // PGRST116 = "no rows returned" which is expected for new machines
      throw new MachineRegistrationError(
        `Failed to check existing machine: ${selectError.message}`,
        selectError
      );
    }

    if (existing) {
      // Machine already registered, update last_seen
      const { error: updateError } = await supabase
        .from('machines')
        .update({
          last_seen_at: new Date().toISOString(),
          is_online: true,
          name: machineName, // Update name in case hostname changed
          platform_version: platformVersion,
        })
        .eq('id', existing.id);

      if (updateError) {
        logger.warn('Failed to update machine last_seen', { error: updateError.message });
      }

      logger.debug('Machine already registered', { machineId: existing.id });

      return {
        isNew: false,
        machine: {
          machineId: existing.id,
          fingerprint: existing.fingerprint,
          machineName: existing.name || machineName,
          platform: existing.platform || platform,
          platformVersion,
        },
        registeredAt: existing.created_at,
      };
    }

    // New machine - generate ID and insert
    const machineId = existingMachineId || generateMachineId();
    const now = new Date().toISOString();

    const { data: inserted, error: insertError } = await supabase
      .from('machines')
      .insert({
        id: machineId,
        user_id: userId,
        fingerprint,
        name: machineName,
        platform,
        platform_version: platformVersion,
        is_online: true,
        last_seen_at: now,
        created_at: now,
      })
      .select('id, fingerprint, name, platform, created_at')
      .single();

    if (insertError) {
      // Handle unique constraint violation (race condition)
      if (insertError.code === '23505') {
        // Retry with select
        return registerMachine(supabase, userId, existingMachineId);
      }
      throw new MachineRegistrationError(
        `Failed to register machine: ${insertError.message}`,
        insertError
      );
    }

    logger.debug('New machine registered', { machineId: inserted.id });

    return {
      isNew: true,
      machine: {
        machineId: inserted.id,
        fingerprint: inserted.fingerprint,
        machineName: inserted.name || machineName,
        platform: inserted.platform || platform,
        platformVersion,
      },
      registeredAt: inserted.created_at,
    };
  } catch (error) {
    if (error instanceof MachineRegistrationError) {
      throw error;
    }
    throw new MachineRegistrationError(
      'Unexpected error during machine registration',
      error
    );
  }
}

/**
 * Update machine online status.
 *
 * @param supabase - Authenticated Supabase client
 * @param machineId - Machine ID to update
 * @param isOnline - Whether machine is online
 */
export async function updateMachineStatus(
  supabase: SupabaseClient,
  machineId: string,
  isOnline: boolean
): Promise<void> {
  const { error } = await supabase
    .from('machines')
    .update({
      is_online: isOnline,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', machineId);

  if (error) {
    logger.warn('Failed to update machine status', { machineId, error: error.message });
  }
}

/**
 * Get machine info by ID.
 *
 * @param supabase - Authenticated Supabase client
 * @param machineId - Machine ID to look up
 * @returns Machine info or null if not found
 */
export async function getMachine(
  supabase: SupabaseClient,
  machineId: string
): Promise<MachineInfo | null> {
  const { data, error } = await supabase
    .from('machines')
    .select('id, fingerprint, name, platform, platform_version')
    .eq('id', machineId)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    machineId: data.id,
    fingerprint: data.fingerprint,
    machineName: data.name,
    platform: data.platform,
    platformVersion: data.platform_version,
  };
}

/**
 * Default export for module
 */
export default {
  generateMachineFingerprint,
  generateMachineId,
  getMachineName,
  getPlatform,
  getPlatformVersion,
  registerMachine,
  updateMachineStatus,
  getMachine,
  MachineRegistrationError,
};
