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
  /** Default agent type */
  defaultAgent?: 'claude' | 'codex' | 'gemini';
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
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content) as StyrbyConfig;
    }
  } catch {
    // Return empty config on error
  }
  return {};
}

/**
 * Save configuration to disk.
 *
 * @param config - Configuration to save
 */
export function saveConfig(config: StyrbyConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600, // Owner read/write only
  });
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
