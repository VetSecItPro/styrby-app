/**
 * Encodes a JavaScript string to a UTF-8 `Uint8Array`.
 *
 * Thin wrapper around `TextEncoder` — centralised here so callers never
 * instantiate `TextEncoder` inline and to make the encoding explicit in
 * cryptographic contexts (e.g., before passing to HMAC or NaCl).
 *
 * @param value - The string to encode.
 * @returns A `Uint8Array` of UTF-8 bytes.
 *
 * @example
 * const bytes = encodeUTF8('Styrby');
 * // bytes instanceof Uint8Array === true
 */
export function encodeUTF8(value: string) {
    return new TextEncoder().encode(value);
}

/**
 * Decodes a UTF-8 `Uint8Array` back to a JavaScript string.
 *
 * Thin wrapper around `TextDecoder` — pair with `encodeUTF8` when
 * round-tripping strings through binary crypto operations.
 *
 * @param value - A `Uint8Array` of UTF-8 encoded bytes.
 * @returns The decoded string. Replacement character (U+FFFD) is substituted
 *   for invalid byte sequences per the WHATWG Encoding specification.
 *
 * @example
 * const str = decodeUTF8(new Uint8Array([83, 116, 121, 114, 98, 121]));
 * // str === 'Styrby'
 */
export function decodeUTF8(value: Uint8Array) {
    return new TextDecoder().decode(value);
}

/**
 * Normalizes a string to NFKD (Compatibility Decomposition) form.
 *
 * WHY: BIP-39 mnemonic and key-derivation standards require NFKD normalization
 * before encoding user-supplied strings (e.g., passphrases) so that visually
 * identical but byte-different Unicode representations always produce the same
 * key material. Without normalization, accented characters entered from
 * different keyboards could silently produce different derived keys.
 *
 * @param value - The string to normalize.
 * @returns The NFKD-normalized string.
 *
 * @example
 * normalizeNFKD('\u00e9');         // é (composed) → 'e\u0301' (decomposed)
 * normalizeNFKD('cafe\u0301');     // already decomposed → unchanged
 */
export function normalizeNFKD(value: string) {
    return value.normalize('NFKD');
}
