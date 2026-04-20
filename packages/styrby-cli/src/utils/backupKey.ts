/**
 * Backup key formatting utilities.
 * Formats secret keys in the same way as the mobile client for compatibility.
 */

// Base32 alphabet (RFC 4648) - excludes confusing characters (0, 1, 8, 9)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encodes a byte array as a Base32 string using the RFC 4648 alphabet.
 *
 * WHY: Base32 is preferred over Base64 for human-readable backup keys because
 * it uses only uppercase letters and digits 2-7, avoiding visually ambiguous
 * characters (0/O, 1/I/l). This matches the mobile client's encoding so that
 * keys displayed on desktop and mobile are always identical.
 *
 * The implementation processes 5-bit groups from the input bytes without
 * padding, consistent with how the mobile client strips `=` padding before
 * display.
 *
 * @param bytes - Raw bytes to encode (typically a 32-byte secret key).
 * @returns The Base32-encoded string (uppercase, no padding characters).
 *
 * @example
 * bytesToBase32(new Uint8Array([0xde, 0xad, 0xbe])); // '3WK3Y'
 */
function bytesToBase32(bytes: Uint8Array): string {
    let result = '';
    let buffer = 0;
    let bufferLength = 0;

    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;

        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
        }
    }

    // Handle remaining bits
    if (bufferLength > 0) {
        result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
    }

    return result;
}

/**
 * Formats a 32-byte secret key as a human-readable backup string.
 *
 * The key is Base32-encoded (RFC 4648, no padding) then split into groups of
 * 5 characters joined by dashes. A 32-byte input produces 52 Base32 characters
 * (256 bits / 5 bits per character, rounded up) formatted as approximately
 * 11 groups of 5.
 *
 * WHY: Grouping by 5 with dash separators matches the mobile client's display
 * format, making it easy for users to visually compare and manually type the
 * key during account recovery without transcription errors.
 *
 * @param secretBytes - 32-byte secret key as a `Uint8Array`. Passing fewer or
 *   more bytes is allowed but may produce a non-standard group count.
 * @returns A dash-separated Base32 string, e.g.:
 *   `"ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z2345-67AAB"`
 *
 * @example
 * const key = crypto.getRandomValues(new Uint8Array(32));
 * const display = formatSecretKeyForBackup(key);
 * // display === 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX...'
 */
export function formatSecretKeyForBackup(secretBytes: Uint8Array): string {
    // Convert to base32
    const base32 = bytesToBase32(secretBytes);

    // Split into groups of 5 characters
    const groups: string[] = [];
    for (let i = 0; i < base32.length; i += 5) {
        groups.push(base32.slice(i, i + 5));
    }

    // Join with dashes
    // 32 bytes = 256 bits = 52 base32 chars (51.2 rounded up)
    // That's approximately 11 groups of 5 chars
    return groups.join('-');
}
