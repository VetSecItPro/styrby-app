/**
 * Secret Store — Platform Keychain Backed Storage with Encrypted Fallback
 *
 * SECURITY (CLI-006, audit 2026-05-04): The Styrby API key (`styrby_*`) was
 * previously stored plaintext in `~/.styrby/data.json` (mode 0o600). File
 * permissions stop other Unix users but they don't stop:
 *   - Anything running as the same UID (other npm packages, dev tools)
 *   - Backup tools that copy `$HOME` (Time Machine, Arq, restic dotfiles)
 *   - Cloud sync that lifts the dotfile (Dropbox, OneDrive, iCloud Drive)
 *   - Forensic acquisition of an unlocked device
 *
 * This module persists the secret in the OS keychain via `keytar`:
 *   - macOS: Keychain Services
 *   - Linux: libsecret / GNOME Keyring / KWallet (D-Bus)
 *   - Windows: Credential Vault
 *
 * Fallback: if keytar fails (headless server with no D-Bus, missing
 * libsecret-1.so.0, etc.) we encrypt-at-rest into a sibling file using
 * AES-256-GCM keyed off a machine-fingerprint. NOT plaintext — that defeats
 * the purpose. The fallback is weaker than the keychain (the key derivation
 * is reversible by anything that can read the user's home dir) but it
 * still defeats casual `cat ~/.styrby/secrets.bin` and offline-backup grep.
 *
 * @module auth/secret-store
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from '@/ui/logger';

/**
 * Platform keychain service identifier.
 * All Styrby secrets are namespaced under this service so an operator can
 * see/audit them in `security find-generic-password -s styrby-cli` etc.
 */
const KEYCHAIN_SERVICE = 'styrby-cli';

/**
 * Path to the encrypted-at-rest fallback file (only used when keytar fails).
 * Intentionally separate from data.json so the persistence layer never
 * accidentally serialises this content as JSON / commits it to telemetry.
 */
const FALLBACK_DIR = path.join(os.homedir(), '.styrby');
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'secrets.enc');

/**
 * Cached lazy-loaded keytar handle. We try-catch the require() because
 * keytar's native binding fails to load on platforms where libsecret is
 * missing — and we want to fall back gracefully, not crash the CLI.
 */
let keytarMod: typeof import('keytar') | null | undefined = undefined;

/**
 * Attempt to load keytar. Returns the module on success, or `null` if it
 * cannot be loaded (Linux server with no libsecret, restricted sandbox, etc.).
 */
async function tryGetKeytar(): Promise<typeof import('keytar') | null> {
  if (keytarMod !== undefined) return keytarMod;
  try {
    keytarMod = await import('keytar');
    return keytarMod;
  } catch (e) {
    logger.debug('[secret-store] keytar unavailable, falling back to encrypted file', {
      error: e instanceof Error ? e.message : String(e),
    });
    keytarMod = null;
    return null;
  }
}

/**
 * Probe keytar availability AND that the OS keychain is actually responding.
 * keytar may import successfully on Linux but `getPassword` throws if the
 * D-Bus secret service isn't running — we need to detect that too.
 */
async function isKeytarUsable(): Promise<boolean> {
  const k = await tryGetKeytar();
  if (!k) return false;
  try {
    await k.findCredentials(KEYCHAIN_SERVICE);
    return true;
  } catch (e) {
    logger.debug('[secret-store] keytar present but keychain unreachable', {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Derive a 32-byte AES key from a machine fingerprint.
 *
 * WHY: The fallback file lives on disk, so we need to encrypt it. We can't
 * prompt the user for a passphrase (CLI must work non-interactively). We
 * derive a key from `hostname + os user + os.arch` so the encrypted blob is
 * not portable to another machine — an attacker who copies just the file
 * (e.g. via cloud sync) cannot decrypt it elsewhere.
 *
 * Limitations: an attacker with code-exec on the same machine can rebuild
 * this key trivially. That's an accepted tradeoff — keytar is the strong
 * path; this fallback only beats casual `cat` / backup grep.
 */
function deriveFallbackKey(): Buffer {
  const fingerprint = `${os.hostname()}|${os.userInfo().username}|${os.platform()}|${os.arch()}`;
  return crypto.createHash('sha256').update(fingerprint).digest();
}

/**
 * Read+parse the encrypted fallback store.
 * Returns `{}` if the file doesn't exist or is corrupt (corruption is
 * logged at warn so it's visible, but not fatal — caller treats absence
 * the same as a missing key).
 */
async function readFallback(): Promise<Record<string, string>> {
  try {
    await fs.access(FALLBACK_FILE, fsConstants.R_OK);
  } catch {
    return {};
  }
  try {
    const raw = await fs.readFile(FALLBACK_FILE);
    // Layout: [12B IV][16B tag][N ciphertext bytes]
    if (raw.length < 12 + 16 + 1) throw new Error('fallback file truncated');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const key = deriveFallbackKey();
    // Pin authTagLength to 16 (CVE-class defense + semgrep's gcm-no-tag-length rule).
    // Without an explicit length, an attacker who can manipulate stored ciphertext
    // could truncate the tag to bypass authenticity checks on some implementations.
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Record<string, string>;
  } catch (e) {
    logger.warn('[secret-store] fallback file unreadable, treating as empty', {
      error: e instanceof Error ? e.message : String(e),
    });
    return {};
  }
}

/**
 * Encrypt and atomically write the fallback store with mode 0o600.
 */
async function writeFallback(state: Record<string, string>): Promise<void> {
  await fs.mkdir(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  const key = deriveFallbackKey();
  const iv = crypto.randomBytes(12);
  // Pin authTagLength to 16 — paired with the createDecipheriv setting above.
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const plain = Buffer.from(JSON.stringify(state), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ct]);
  // Atomic write: tmp + rename so we never leave a partial file on disk.
  const tmp = FALLBACK_FILE + '.tmp';
  await fs.writeFile(tmp, blob, { mode: 0o600 });
  await fs.rename(tmp, FALLBACK_FILE);
}

/**
 * Get a stored secret by name.
 *
 * Looks up the keychain first; falls back to the encrypted file if keytar
 * is unavailable. Returns `null` when the secret is not present in either.
 *
 * @param name - Secret identifier (e.g. 'styrby_api_key')
 * @returns The secret value, or `null` if not found
 */
export async function getSecret(name: string): Promise<string | null> {
  if (await isKeytarUsable()) {
    const k = (await tryGetKeytar())!;
    const v = await k.getPassword(KEYCHAIN_SERVICE, name);
    if (v) return v;
    // Not in keychain — also peek in fallback so a half-migrated install works.
  }
  const fb = await readFallback();
  return fb[name] ?? null;
}

/**
 * Persist a secret. Uses keytar when available, otherwise the encrypted file.
 *
 * @param name - Secret identifier
 * @param value - Secret value (UTF-8)
 */
export async function setSecret(name: string, value: string): Promise<void> {
  if (await isKeytarUsable()) {
    const k = (await tryGetKeytar())!;
    await k.setPassword(KEYCHAIN_SERVICE, name, value);
    return;
  }
  const fb = await readFallback();
  fb[name] = value;
  await writeFallback(fb);
}

/**
 * Remove a secret. Best-effort: tries both backends so a half-migrated
 * install ends up clean.
 *
 * @param name - Secret identifier
 */
export async function deleteSecret(name: string): Promise<void> {
  if (await isKeytarUsable()) {
    const k = (await tryGetKeytar())!;
    try { await k.deletePassword(KEYCHAIN_SERVICE, name); } catch { /* ignore */ }
  }
  const fb = await readFallback();
  if (name in fb) {
    delete fb[name];
    await writeFallback(fb);
  }
}

/**
 * Result of {@link migrateLegacySecret}.
 *
 * - `migrated`: secret was moved from the legacy data.json into the keychain
 * - `already-keychain`: secret was already in the keychain; no-op
 * - `keytar-unavailable`: keytar can't run on this host; legacy file untouched
 * - `not-present`: nothing to migrate (no legacy value)
 */
export type MigrationResult = 'migrated' | 'already-keychain' | 'keytar-unavailable' | 'not-present';

/**
 * Migrate a legacy plaintext secret from data.json into the keychain.
 *
 * Caller is responsible for clearing the legacy field from data.json after
 * a `migrated` result and for writing the audit_log entry
 * `secret_migrated_to_keychain`. We don't touch persistence directly here
 * to keep this module dependency-free.
 *
 * @param name - Keychain secret name
 * @param legacyValue - The plaintext value from data.json (or null if absent)
 */
export async function migrateLegacySecret(
  name: string,
  legacyValue: string | null | undefined
): Promise<MigrationResult> {
  if (!legacyValue) return 'not-present';
  if (!(await isKeytarUsable())) return 'keytar-unavailable';
  const k = (await tryGetKeytar())!;
  const existing = await k.getPassword(KEYCHAIN_SERVICE, name);
  if (existing) return 'already-keychain';
  await k.setPassword(KEYCHAIN_SERVICE, name, legacyValue);
  return 'migrated';
}

/**
 * Test-only: reset the cached keytar handle so tests can re-mock the import.
 * Not exported from the package barrel; tests reach in directly.
 */
export function __resetForTests(): void {
  keytarMod = undefined;
}
