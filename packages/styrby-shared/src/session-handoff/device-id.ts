/**
 * Session Handoff — Device ID Utilities
 *
 * Pure helpers for generating and parsing device IDs.
 * Storage is handled by each surface (AsyncStorage / localStorage / file).
 *
 * WHY UUID v7: Time-ordered UUIDs allow chronological sorting without an
 * extra timestamp column, which helps when listing a user's devices by
 * "first seen" order without a separate created_at field.
 *
 * @module session-handoff/device-id
 */

/**
 * Generates a new UUID v7 string (time-ordered UUID).
 *
 * WHY custom implementation: The `uuid` npm package adds ~8 KB to the
 * mobile/web bundle for functionality we can implement inline.
 * UUID v7 format: 48-bit Unix timestamp ms + 4-bit version (7) +
 * 12-bit random + 2-bit variant + 62-bit random.
 *
 * @returns A new UUID v7 string in canonical hyphenated format
 */
export function generateDeviceId(): string {
  const nowMs = Date.now();

  // 48-bit timestamp (ms since epoch) as big-endian hex
  const timeLo = (nowMs & 0xffffffff) >>> 0;
  const timeHi = Math.floor(nowMs / 0x100000000) & 0xffff;

  // 12-bit random (rand_a, lower 12 bits of the version nibble word)
  const randA = crypto.getRandomValues(new Uint16Array(1))[0] & 0x0fff;

  // 62-bit random split across two 32-bit words (rand_b)
  const [randB1, randB2] = Array.from(crypto.getRandomValues(new Uint32Array(2)));

  // Assemble per RFC 9562 §5.7
  // time_high (16 bits) | time_mid (16 bits) | time_low (32 bits)
  const p1 = timeHi.toString(16).padStart(4, '0');
  const p2 = ((nowMs >> 16) & 0xffff).toString(16).padStart(4, '0');
  const p3 = timeLo.toString(16).padStart(8, '0');

  // Version nibble: 0111 = 7
  const p4 = (0x7000 | randA).toString(16).padStart(4, '0');

  // Variant nibble: 10xx = 8-b (force two high bits to 10)
  const variantBits = (randB1 >>> 16) & 0x3fff;
  const p5 = (0x8000 | variantBits).toString(16).padStart(4, '0');

  const p6 = (randB1 & 0xffff).toString(16).padStart(4, '0');
  const p7 = randB2.toString(16).padStart(8, '0');

  return `${p3}-${p2}-${p4}-${p5}-${p6}${p7}`;
}

/**
 * Validates that a string looks like a UUID (any version).
 *
 * WHY: device_id is user-supplied from persistent storage which could be
 * corrupted. We reject non-UUID strings before they reach the Supabase
 * INSERT so we get a clear error rather than a silent DB constraint failure.
 *
 * @param id - String to validate
 * @returns true if `id` matches the UUID canonical format
 */
export function isValidDeviceId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
