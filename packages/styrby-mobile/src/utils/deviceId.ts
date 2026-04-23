/**
 * Mobile Device ID — Stable device identity for session handoff.
 *
 * Generates a UUID v7 on first launch and persists it to a local file via
 * `expo-file-system`. The same ID is used for every snapshot written from
 * this device, so the handoff banner can correctly identify which physical
 * device last had the session open.
 *
 * WHY expo-file-system (not AsyncStorage):
 *   AsyncStorage is not in the mobile package's dependencies. `expo-file-system`
 *   is already installed and handles plain file reads/writes. The device ID is
 *   not a secret, so SecureStore is unnecessary — file system is appropriate.
 *
 * WHY not SecureStore:
 *   SecureStore is reserved for auth tokens and encryption keys. The device ID
 *   is a non-secret stable identifier and does not warrant biometric gating.
 *
 * @module utils/deviceId
 */

import * as FileSystem from 'expo-file-system';
import { generateDeviceId, isValidDeviceId } from '@styrby/shared/session-handoff';

/** Path to the persisted device ID file in Expo's document directory. */
const DEVICE_ID_FILE = `${FileSystem.documentDirectory}styrby-device-id.txt`;

/**
 * In-process cache — avoids repeated file I/O after the first call.
 */
let _cached: string | null = null;

/**
 * Returns the cached device ID or reads from the file system.
 *
 * On first call: reads from `${documentDirectory}/styrby-device-id.txt`.
 * If absent or corrupt, generates a new UUID v7, writes it, and caches it.
 * Subsequent calls return the in-process cache without file I/O overhead.
 *
 * @returns Promise resolving to the stable device ID (UUID v7 format)
 */
export async function getMobileDeviceId(): Promise<string> {
  if (_cached && isValidDeviceId(_cached)) {
    return _cached;
  }

  try {
    const info = await FileSystem.getInfoAsync(DEVICE_ID_FILE);

    if (info.exists) {
      const stored = (await FileSystem.readAsStringAsync(DEVICE_ID_FILE)).trim();

      if (isValidDeviceId(stored)) {
        _cached = stored;
        return stored;
      }
      // File exists but content is corrupt — fall through to regenerate.
    }

    // Generate and persist a new device ID.
    const newId = generateDeviceId();
    await FileSystem.writeAsStringAsync(DEVICE_ID_FILE, newId);
    _cached = newId;
    return newId;
  } catch {
    // File system failure — generate an ephemeral ID for this session.
    // The handoff feature degrades gracefully rather than crashing.
    const ephemeral = generateDeviceId();
    return ephemeral;
  }
}
