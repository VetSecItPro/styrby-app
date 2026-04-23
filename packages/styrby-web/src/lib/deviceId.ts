/**
 * Web Device ID — Stable browser device identity for session handoff.
 *
 * Generates a UUID v7 on first use and persists it in `localStorage` under
 * the key `styrby_device_id`. The same ID is used for every handoff snapshot
 * written from this browser profile, enabling the handoff banner to correctly
 * identify the origin device.
 *
 * WHY localStorage over a cookie: Cookies are sent on every request (latency
 * + size overhead). We only need the device ID when writing snapshots and
 * querying the handoff endpoint — on-demand reads from localStorage cost ~0.
 *
 * @module lib/deviceId
 */

import { generateDeviceId, isValidDeviceId } from '@styrby/shared/session-handoff';

/** localStorage key for the stable device ID. */
const STORAGE_KEY = 'styrby_device_id';

/**
 * Returns the stable device ID for this browser profile.
 *
 * On first call (or if stored value is corrupt) generates a new UUID v7,
 * persists it to localStorage, and returns it. Subsequent calls return the
 * stored value.
 *
 * WHY: The device ID must survive page refreshes and tab reopens. A new
 * ID on every session load would break handoff continuity — each write
 * would appear to come from a "different" device.
 *
 * @returns The stable device ID string (UUID v7 format)
 */
export function getWebDeviceId(): string {
  if (typeof window === 'undefined') {
    // SSR path — device ID is not meaningful on the server.
    // Return a deterministic placeholder so callers never get an empty string.
    return 'ssr-no-device-id';
  }

  const stored = localStorage.getItem(STORAGE_KEY);

  if (stored && isValidDeviceId(stored)) {
    return stored;
  }

  // Generate and persist a new device ID.
  const newId = generateDeviceId();
  localStorage.setItem(STORAGE_KEY, newId);
  return newId;
}
