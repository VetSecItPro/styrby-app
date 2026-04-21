/**
 * Daemon Config File — ~/.styrby/config.json
 *
 * Provides a persistent fallback for SUPABASE_URL and SUPABASE_ANON_KEY when the
 * daemon starts via a LaunchAgent or systemd unit before any shell profile (.zshrc,
 * .zprofile) has been sourced.
 *
 * WHY: On macOS, `launchd` only injects the environment variables that were
 * explicitly baked into the plist EnvironmentVariables dict at install time. If the
 * plist was installed before the Supabase keys were available (e.g., from an older
 * `styrby onboard` flow), or if the plist was regenerated without them, the daemon
 * would otherwise fail to connect on every fresh boot. This config file is the
 * last-resort fallback so the daemon stays operational even when the plist is stale.
 *
 * Precedence order used by callers:
 *   1. process.env (highest — wins if env var is injected by plist/unit)
 *   2. ~/.styrby/config.json (this file)
 *   3. Hard error with actionable message
 *
 * File is written at mode 0o600 (owner read/write only) because it contains
 * the Supabase anon key — world-readable would allow any user on the box to
 * make authenticated API calls against the project.
 *
 * @module daemon/configFile
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Types
// ============================================================================

/**
 * Shape of ~/.styrby/config.json.
 *
 * Written on first successful onboard/auth so it is present for subsequent
 * LaunchAgent or systemd boots even if the service file is stale.
 */
export interface DaemonConfig {
  /** Supabase project URL (https://<ref>.supabase.co) */
  supabaseUrl: string;

  /** Supabase anon / publishable key */
  supabaseAnonKey: string;

  /** Registered machine UUID */
  machineId?: string;

  /** ISO-8601 timestamp when this config was first written */
  createdAt: string;

  /** ISO-8601 timestamp of the most recent write */
  updatedAt: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Absolute path to the daemon config file. */
export const CONFIG_FILE_PATH = path.join(os.homedir(), '.styrby', 'config.json');

// ============================================================================
// Read
// ============================================================================

/**
 * Load the daemon config from ~/.styrby/config.json.
 *
 * Returns `null` — instead of throwing — for both the "file absent" and the
 * "malformed JSON" cases so callers can fall through to their own error handler
 * without wrapping every call in try/catch.
 *
 * WHY: The daemon's `connectToRelay()` already has explicit error state management.
 * A null return lets it set `connectionState = 'error'` with a targeted message
 * rather than crashing on an unhandled exception.
 *
 * @returns Parsed config object, or null if the file is missing or invalid
 *
 * @example
 * const cfg = loadDaemonConfig();
 * const url = process.env.SUPABASE_URL ?? cfg?.supabaseUrl ?? null;
 */
export function loadDaemonConfig(): DaemonConfig | null {
  if (!fs.existsSync(CONFIG_FILE_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as DaemonConfig;

    // WHY: A partial write or hand-edit could produce an object that passes
    // JSON.parse but is missing the required keys. Validate the minimum viable
    // shape before returning so callers can trust the object they receive.
    if (typeof parsed.supabaseUrl !== 'string' || typeof parsed.supabaseAnonKey !== 'string') {
      console.warn('[daemon/configFile] ~/.styrby/config.json is missing required fields — ignoring');
      return null;
    }

    return parsed;
  } catch {
    // WHY: Log a warning rather than rethrowing. A corrupted config.json should
    // not crash the daemon — it should fall through to the "run styrby onboard"
    // error message so the user gets an actionable fix.
    console.warn('[daemon/configFile] Failed to parse ~/.styrby/config.json — ignoring (file may be corrupted)');
    return null;
  }
}

// ============================================================================
// Write
// ============================================================================

/**
 * Write or update ~/.styrby/config.json with the given fields.
 *
 * Merges with an existing config if present so unrelated fields are preserved.
 * Creates the `~/.styrby/` directory if it does not exist.
 * Writes at mode 0o600 (owner read/write only) to protect the anon key.
 *
 * @param fields - Partial config fields to upsert
 *
 * @example
 * writeDaemonConfig({
 *   supabaseUrl: 'https://abc.supabase.co',
 *   supabaseAnonKey: 'eyJ...',
 *   machineId: 'uuid-here',
 * });
 */
export function writeDaemonConfig(fields: Partial<Omit<DaemonConfig, 'createdAt' | 'updatedAt'>>): void {
  const configDir = path.dirname(CONFIG_FILE_PATH);

  if (!fs.existsSync(configDir)) {
    // WHY: Same pattern as data.json — ensure the .styrby dir exists before writing.
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const existing = loadDaemonConfig();
  const now = new Date().toISOString();

  const next: DaemonConfig = {
    // Carry forward existing values as defaults
    supabaseUrl: existing?.supabaseUrl ?? '',
    supabaseAnonKey: existing?.supabaseAnonKey ?? '',
    machineId: existing?.machineId,
    createdAt: existing?.createdAt ?? now,
    // Apply new fields on top
    ...fields,
    // Always refresh updatedAt
    updatedAt: now,
  };

  // WHY: mode 0o600 — the anon key must not be world-readable. Any other user on
  // the machine could use it to make API calls against the Supabase project.
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}
