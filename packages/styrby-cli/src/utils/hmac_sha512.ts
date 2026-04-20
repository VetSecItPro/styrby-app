import { createHmac } from 'node:crypto'

/**
 * Computes HMAC-SHA512 over `data` using `key`.
 *
 * WHY: HMAC-SHA512 (RFC 2104 / FIPS 198-1) is the standard MAC used by
 * BIP-32 HD key derivation and NIST SP 800-108 KDFs. The 64-byte output
 * provides 256 bits of security and is designed to be split into two
 * independent 32-byte values (key + chain code) without weakening either.
 *
 * Uses Node's built-in `crypto.createHmac` which delegates to OpenSSL,
 * ensuring a constant-time, audited implementation.
 *
 * @param key  - HMAC key material as a `Uint8Array`. For key-derivation
 *               use cases this is either the usage-label bytes (root step)
 *               or a parent chain code (child step). Must be non-empty.
 * @param data - Input data to authenticate. May be arbitrary length.
 * @returns    A 64-byte `Uint8Array` containing the raw HMAC-SHA512 digest.
 * @throws {Error} If `key` is zero-length or Node's crypto module is
 *   unavailable (e.g., built without OpenSSL).
 *
 * @example
 * const digest = await hmac_sha512(
 *   new TextEncoder().encode('Styrby Master Seed'),
 *   seed
 * );
 * const keyMaterial  = digest.slice(0, 32);
 * const chainCode    = digest.slice(32);
 */
export async function hmac_sha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const hmac = createHmac('sha512', key)
    hmac.update(data)
    return new Uint8Array(hmac.digest())
}
