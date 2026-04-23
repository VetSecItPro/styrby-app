/**
 * CLI Device ID — Stable terminal device identity for session handoff.
 *
 * Reads `~/.styrby/device-id` on first call. If the file is absent or
 * contains an invalid value, generates a new UUID v7 and writes it to disk
 * (mode 0o600 — owner-read/write only).
 *
 * WHY `~/.styrby/device-id` (not `data.json`): The device ID conceptually
 * belongs to the physical machine, not to any authenticated session. Storing
 * it separately keeps the data model clean and allows the ID to survive
 * `styrby logout` which would clear `data.json`.
 *
 * @module session/device-id
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, ensureConfigDir } from '../configuration.js';
import { generateDeviceId, isValidDeviceId } from '@styrby/shared/session-handoff';

/** Absolute path to the CLI device ID file. */
const DEVICE_ID_FILE = path.join(CONFIG_DIR, 'device-id');

/**
 * In-process cache — avoids repeated disk reads after the first call.
 */
let _cached: string | null = null;

/**
 * Returns the stable device ID for this CLI installation.
 *
 * On first call (or after cache invalidation):
 * 1. Reads `~/.styrby/device-id`.
 * 2. If absent or corrupt, generates a new UUID v7 and writes it.
 * 3. Caches the result in-process for subsequent calls.
 *
 * WHY synchronous FS: The CLI is a Node.js process — synchronous FS in the
 * startup path is acceptable and avoids async cascades in callers that need
 * the device ID during initial config resolution.
 *
 * @returns The stable device ID string (UUID v7 format)
 */
export function getCliDeviceId(): string {
  if (_cached && isValidDeviceId(_cached)) {
    return _cached;
  }

  // Try to read existing file.
  if (fs.existsSync(DEVICE_ID_FILE)) {
    try {
      const stored = fs.readFileSync(DEVICE_ID_FILE, 'utf-8').trim();

      if (isValidDeviceId(stored)) {
        _cached = stored;
        return stored;
      }
      // Fall through: file exists but content is corrupt — regenerate.
    } catch {
      // Read error — regenerate.
    }
  }

  // Generate and persist a new device ID.
  ensureConfigDir();
  const newId = generateDeviceId();

  // Mode 0o600: only the file owner can read or write the device ID.
  // WHY: Although the device ID is not a secret, restricting access
  // prevents other local users on a shared machine from reading it and
  // forging snapshots attributed to this device.
  fs.writeFileSync(DEVICE_ID_FILE, newId, { encoding: 'utf-8', mode: 0o600 });

  _cached = newId;
  return newId;
}

/**
 * Clears the in-process cache.
 * Intended for tests that need to simulate a fresh first-run.
 *
 * @internal
 */
export function _clearDeviceIdCache(): void {
  _cached = null;
}
