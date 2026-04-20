import * as hex from '@stablelib/hex';

/**
 * Decodes a hex-encoded string into a `Uint8Array`.
 *
 * @param hexString - Hex string to decode. In `'normal'` format this is a
 *   plain hex string (e.g., `"deadbeef"`). In `'mac'` format the bytes are
 *   colon-separated (e.g., `"de:ad:be:ef"`), as used in MAC address notation.
 * @param format    - `'normal'` (default) for plain hex; `'mac'` to strip
 *   colon separators before decoding.
 * @returns The decoded bytes as a `Uint8Array`.
 * @throws {Error} If `hexString` contains non-hex characters after separator
 *   removal (delegated to `@stablelib/hex`).
 *
 * @example
 * decodeHex('deadbeef');            // Uint8Array([0xde, 0xad, 0xbe, 0xef])
 * decodeHex('de:ad:be:ef', 'mac'); // Uint8Array([0xde, 0xad, 0xbe, 0xef])
 */
export function decodeHex(hexString: string, format: 'normal' | 'mac' = 'normal'): Uint8Array {
    if (format === 'mac') {
        const encoded = hexString.replace(/:/g, '');
        return hex.decode(encoded);
    }
    return hex.decode(hexString);
}

/**
 * Encodes a `Uint8Array` as a lowercase hex string.
 *
 * @param buffer - Bytes to encode.
 * @param format - `'normal'` (default) for a plain hex string; `'mac'` to
 *   insert colon separators between every byte pair (MAC address style).
 * @returns The hex-encoded string, or an empty string if `buffer` is empty
 *   and `format` is `'mac'` (regex match returns null).
 *
 * @example
 * encodeHex(new Uint8Array([0xde, 0xad]));            // 'dead'
 * encodeHex(new Uint8Array([0xde, 0xad]), 'mac');     // 'de:ad'
 */
export function encodeHex(buffer: Uint8Array, format: 'normal' | 'mac' = 'normal'): string {
    if (format === 'mac') {
        const encoded = hex.encode(buffer);
        return encoded.match(/.{2}/g)?.join(':') || '';
    }
    return hex.encode(buffer);
}
