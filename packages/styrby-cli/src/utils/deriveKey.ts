import { hmac_sha512 } from "./hmac_sha512";

/**
 * Holds the output of a single HMAC-SHA512 key-derivation step.
 * Mirrors the split-key structure used in BIP-32 HD key trees:
 * the left 32 bytes become the child key and the right 32 bytes
 * become the chain code for subsequent derivation steps.
 */
export type KeyTreeState = {
    key: Uint8Array,
    chainCode: Uint8Array
};

/**
 * Derives the root node of a hierarchical secret-key tree from a seed.
 *
 * WHY: Follows the HMAC-SHA512 key-derivation pattern from NIST SP 800-108
 * (KDF in counter mode / feedback mode) and BIP-32 HD wallet root derivation.
 * The `usage` string acts as the HMAC key prefix so that different applications
 * sharing the same seed produce cryptographically independent root keys.
 *
 * The 64-byte HMAC output is split deterministically:
 *   - Left  32 bytes → root secret key (I_L)
 *   - Right 32 bytes → chain code used to derive child keys (I_R)
 *
 * @param seed   - Entropy source (e.g., 32-byte random master secret).
 *                 Must be high-entropy; do NOT pass a password directly.
 * @param usage  - Application-scoped label (e.g., "Styrby Encryption").
 *                 Namespaces the root so two different `usage` values yield
 *                 independent key trees even with an identical seed.
 * @returns A `KeyTreeState` containing the 32-byte root key and 32-byte chain code.
 * @throws {Error} If the underlying HMAC computation fails (e.g., invalid key length).
 *
 * @example
 * const seed = crypto.getRandomValues(new Uint8Array(32));
 * const root = await deriveSecretKeyTreeRoot(seed, 'Styrby Encryption');
 * // root.key      → 32-byte encryption key
 * // root.chainCode → 32-byte value for child derivation
 */
export async function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): Promise<KeyTreeState> {
    // WHY: HMAC-SHA512 per NIST SP 800-108 §5.1 — the usage label is the HMAC key
    // (prepended with " Master Seed") so the output is domain-separated per tree.
    const I = await hmac_sha512(new TextEncoder().encode(usage + ' Master Seed'), seed);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32)
    };
}

/**
 * Derives a child key from a parent chain code and a string index.
 *
 * WHY: Implements the hardened child derivation step of a BIP-32-style HD key
 * tree using HMAC-SHA512 (NIST SP 800-108 feedback mode). Prepending 0x00
 * before the index string provides domain separation between the chain-code
 * namespace and the key namespace, preventing cross-level collisions.
 *
 * Each invocation is deterministic: same `chainCode` + same `index` always
 * produces the same child state, making the tree fully reproducible from the
 * original seed without storing intermediate keys.
 *
 * @param chainCode - 32-byte chain code output from the parent derivation step.
 *                    Acts as the HMAC key for this level.
 * @param index     - String identifier for this child node (e.g., a user ID,
 *                    path component, or purpose label). Must be non-empty.
 * @returns A `KeyTreeState` with the derived 32-byte child key and its
 *          32-byte chain code for further derivation.
 * @throws {Error} If the HMAC computation fails (e.g., zero-length chain code).
 *
 * @example
 * const child = await deriveSecretKeyTreeChild(root.chainCode, 'session-123');
 * // child.key → 32-byte key scoped to 'session-123'
 */
export async function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): Promise<KeyTreeState> {
    // WHY: 0x00 byte prefix provides domain separation between the key and index
    // namespaces, consistent with BIP-32 hardened derivation semantics.
    const data = new Uint8Array([0x0, ...new TextEncoder().encode(index)]); // prepend 0x00 for separator

    // Derive key via HMAC-SHA512 per NIST SP 800-108 feedback mode
    const I = await hmac_sha512(chainCode, data);
    return {
        key: I.subarray(0, 32),
        chainCode: I.subarray(32),
    };
}

/**
 * Derives a purpose-scoped secret key by walking a path through an HD key tree.
 *
 * WHY: Provides a single ergonomic entry point for all key derivation in Styrby.
 * Starting from a high-entropy master seed, `usage` establishes the root key
 * domain (e.g., "Styrby Encryption" vs "Styrby Auth") and each `path` segment
 * descends one level in the HMAC-SHA512 key tree (NIST SP 800-108 feedback
 * mode / BIP-32 hardened child derivation). This ensures:
 *   1. Keys for different purposes are cryptographically independent.
 *   2. The same path always reproduces the same key (deterministic).
 *   3. No individual derived key reveals the master or sibling keys.
 *
 * @param master - 32-byte (or higher-entropy) master secret. Must be generated
 *                 from a CSPRNG and never shared or logged.
 * @param usage  - Top-level domain label (e.g., "Styrby Encryption").
 *                 Passed to `deriveSecretKeyTreeRoot` as the HMAC key prefix.
 * @param path   - Ordered list of string path components (e.g., `['userId', 'sessionId']`).
 *                 An empty array returns the root key directly.
 * @returns The 32-byte derived key for the specified path, ready for use with
 *          NaCl box/secretbox or AES-GCM operations.
 * @throws {Error} If any HMAC step fails during tree traversal.
 *
 * @example
 * // Derive a per-session encryption key from the master secret
 * const sessionKey = await deriveKey(
 *   masterSecret,
 *   'Styrby Encryption',
 *   [userId, sessionId]
 * );
 */
export async function deriveKey(master: Uint8Array, usage: string, path: string[]): Promise<Uint8Array> {
    let state = await deriveSecretKeyTreeRoot(master, usage);
    let remaining = [...path];
    while (remaining.length > 0) {
        let index = remaining[0];
        remaining = remaining.slice(1);
        state = await deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}
