/**
 * CLI Configuration
 *
 * Manages CLI configuration and settings.
 *
 * WHY: Stub module for Happy Coder's configuration system.
 * We'll store config in ~/.styrby/ instead of ~/.handy/
 *
 * @module configuration
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { SupportedAgentType } from '@/persistence';
import { logger } from '@/ui/logger';

/**
 * Configuration values
 */
export interface StyrbyConfig {
  /** Supabase project URL */
  supabaseUrl?: string;
  /** User's auth token (encrypted) */
  authToken?: string;
  /** Machine ID for this CLI instance */
  machineId?: string;
  /** User ID from Supabase Auth */
  userId?: string;
  /**
   * Default agent type — the canonical 11-agent product union.
   *
   * WHY: previously typed as `'claude' | 'codex' | 'gemini'`, which forced
   * onboard.ts to `as`-cast the runtime value and silently misrepresented
   * the other 8 agents the product supports. Sourced from persistence.ts
   * so config, sessions, and onboarding share one enum.
   */
  defaultAgent?: SupportedAgentType;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Path to the Styrby config directory
 */
export const CONFIG_DIR = path.join(os.homedir(), '.styrby');

/**
 * Path to the main config file
 */
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Ensure config directory exists.
 */
export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load configuration from disk.
 *
 * @returns Loaded configuration or empty object
 */
export function loadConfig(): StyrbyConfig {
  ensureConfigDir();

  let content: string;
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {};
    }
    content = fs.readFileSync(CONFIG_FILE, 'utf-8');
  } catch (err) {
    // WHY (audit 2026-06-09 fix #39): a genuine IO/permission failure was
    // previously swallowed by an empty catch, silently logging the user out
    // (isAuthenticated() -> false) with no diagnostic. Surface it at warn level
    // so a misconfigured ~/.styrby is debuggable, then fall back to empty.
    logger.warn(
      `[config] Could not read ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`
    );
    return {};
  }

  try {
    return JSON.parse(content) as StyrbyConfig;
  } catch (err) {
    // WHY (audit 2026-06-09 fix #39): a corrupt/truncated config.json (e.g. a
    // crash mid-write before saveConfig was made atomic) used to be swallowed
    // here, returning {} and silently bouncing the user into a fresh login,
    // losing their machineId/userId binding. We now log the parse failure
    // loudly so corruption is visible rather than masquerading as "logged out".
    logger.warn(
      `[config] ${CONFIG_FILE} is corrupt and could not be parsed: ${
        err instanceof Error ? err.message : String(err)
      }. Treating as empty config; re-authentication may be required.`
    );
    return {};
  }
}

/**
 * Save configuration to disk.
 *
 * WHY: We pass `mode: 0o600` so newly created files get owner-only permissions.
 * However, on Linux/macOS the `mode` flag in writeFileSync is only applied when
 * the kernel creates a new file (O_CREAT). If config.json already exists from a
 * previous install that had world-readable permissions, the file inherits its
 * old mode. The explicit `chmodSync` call below repairs existing-file permissions
 * on every write, covering the upgrade path. (sec H-05)
 *
 * @param config - Configuration to save
 */
export function saveConfig(config: StyrbyConfig): void {
  ensureConfigDir();
  // WHY (audit 2026-06-09 fix #39): write atomically. The prior direct
  // writeFileSync to CONFIG_FILE was non-atomic — a crash/OOM/power loss between
  // open and full write left a TRUNCATED config.json, which loadConfig() then
  // failed to parse and silently treated as logged-out. Writing to a temp file
  // and renaming into place is atomic on POSIX: a reader sees either the old
  // complete file or the new complete file, never a partial one.
  const tmpFile = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), {
    mode: 0o600, // Owner read/write only — applies only to newly created file
  });
  // Repair permissions on the temp file (upgrade path / pre-existing tmp).
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, CONFIG_FILE);
}

/**
 * Get a specific config value.
 *
 * @param key - Config key to get
 * @returns Config value or undefined
 */
export function getConfigValue<K extends keyof StyrbyConfig>(key: K): StyrbyConfig[K] {
  const config = loadConfig();
  return config[key];
}

/**
 * Set a specific config value.
 *
 * @param key - Config key to set
 * @param value - Value to set
 */
export function setConfigValue<K extends keyof StyrbyConfig>(
  key: K,
  value: StyrbyConfig[K]
): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

/**
 * Check if CLI is authenticated.
 *
 * @returns True if auth token exists
 */
export function isAuthenticated(): boolean {
  const config = loadConfig();
  return !!(config.authToken && config.userId);
}

/**
 * Get the machine ID, creating one if needed.
 *
 * @returns Machine ID
 */
export function getMachineId(): string {
  let machineId = getConfigValue('machineId');
  if (!machineId) {
    machineId = crypto.randomUUID();
    setConfigValue('machineId', machineId);
  }
  return machineId;
}

/**
 * Default export for compatibility
 */
export default {
  CONFIG_DIR,
  CONFIG_FILE,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  isAuthenticated,
  getMachineId,
};
