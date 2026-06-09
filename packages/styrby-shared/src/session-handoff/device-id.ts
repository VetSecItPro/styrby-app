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

  // RFC 9562 §5.7 field layout (big-endian, most-significant timestamp bits
  // FIRST so that lexicographic string order matches chronological order):
  //
  //   unix_ts_ms : 48-bit big-endian millisecond timestamp
  //     ├─ top 32 bits  → first group  (8 hex)  "time_high"
  //     └─ low 16 bits  → second group (4 hex)  "time_low"
  //   ver (4) + rand_a (12) → third group  (4 hex)
  //   var (2) + rand_b high (14) → fourth group (4 hex)
  //   rand_b low (48) → fifth group (12 hex)
  //
  // WHY DIVISION not bit-shift: JavaScript bitwise operators (>>, &) coerce
  // their operands to 32-bit signed integers. A 48-bit ms timestamp (>2^32)
  // would be truncated by `>>`/`&`, scrambling the high bits and breaking
  // chronological ordering. Math.floor(nowMs / 0x10000) computes the true top
  // 32 bits across the full 53-bit safe-integer range.
  const timeHigh = (Math.floor(nowMs / 0x10000) >>> 0).toString(16).padStart(8, '0');
  const timeLow = (nowMs & 0xffff).toString(16).padStart(4, '0');

  // 12-bit random (rand_a) packed with the version nibble (0111 = 7).
  const randA = crypto.getRandomValues(new Uint16Array(1))[0] & 0x0fff;
  const verRandA = (0x7000 | randA).toString(16).padStart(4, '0');

  // 62-bit random (rand_b) split across two 32-bit words.
  const [randB1, randB2] = Array.from(crypto.getRandomValues(new Uint32Array(2)));

  // Variant bits: force top two bits to 10 (RFC 9562 variant), 14 random bits follow.
  const variantRand = (0x8000 | ((randB1 >>> 16) & 0x3fff)).toString(16).padStart(4, '0');

  // Final 48 random bits: low 16 of randB1 + all 32 of randB2.
  const tail = (randB1 & 0xffff).toString(16).padStart(4, '0') + randB2.toString(16).padStart(8, '0');

  return `${timeHigh}-${timeLow}-${verRandA}-${variantRand}-${tail}`;
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
