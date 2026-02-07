/**
 * Environment Configuration
 *
 * Auto-detects development vs production environment and provides
 * appropriate configuration values.
 *
 * Detection order:
 * 1. NODE_ENV environment variable
 * 2. STYRBY_ENV environment variable
 * 3. Auto-detect based on how CLI was invoked
 *
 * @module env
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// ============================================================================
// Types
// ============================================================================

/**
 * Environment type
 */
export type Environment = 'development' | 'production';

/**
 * Environment configuration
 */
export interface EnvConfig {
  /** Current environment */
  env: Environment;
  /** Whether running in development mode */
  isDev: boolean;
  /** Whether running in production mode */
  isProd: boolean;
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase anonymous key */
  supabaseAnonKey: string;
  /** Styrby API URL */
  apiUrl: string;
  /** Styrby website URL */
  webUrl: string;
  /** Debug logging enabled */
  debug: boolean;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect the current environment.
 *
 * @returns Detected environment
 */
function detectEnvironment(): Environment {
  // 1. Explicit env vars take priority
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'development') return 'development';
  if (process.env.STYRBY_ENV === 'production') return 'production';
  if (process.env.STYRBY_ENV === 'development') return 'development';

  // 2. Check if running from dist (compiled) or src (development)
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);

    // If we're in a dist folder, assume production
    if (currentDir.includes('/dist/') || currentDir.includes('\\dist\\')) {
      return 'production';
    }

    // If tsx or ts-node is in the process, assume development
    if (process.argv.some(arg => arg.includes('tsx') || arg.includes('ts-node'))) {
      return 'development';
    }
  } catch {
    // Ignore detection errors
  }

  // 3. Check for common development indicators
  if (process.env.npm_lifecycle_event === 'dev') return 'development';
  if (existsSync(join(process.cwd(), 'tsconfig.json'))) return 'development';

  // Default to production for safety
  return 'production';
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Production Supabase configuration.
 *
 * WHY (FIX-019): Supabase URL is loaded from environment variable only.
 * Hardcoding the URL was a security risk — if the project ref leaked,
 * attackers could target the specific Supabase instance. It also made
 * it impossible to switch projects without a code change.
 */
const PROD_SUPABASE = {
  url: process.env.SUPABASE_URL || '',
  anonKey: process.env.SUPABASE_ANON_KEY || '',
};

/**
 * Development Supabase configuration.
 * Can use local Supabase or same prod instance with dev flag.
 */
const DEV_SUPABASE = {
  url: process.env.SUPABASE_URL || '',
  anonKey: process.env.SUPABASE_ANON_KEY || '',
};

/**
 * Build environment configuration.
 *
 * @param env - Environment type
 * @returns Environment configuration
 */
function buildConfig(env: Environment): EnvConfig {
  const isDev = env === 'development';
  const isProd = env === 'production';

  // Use env vars with environment-appropriate defaults
  const supabase = isDev ? DEV_SUPABASE : PROD_SUPABASE;

  return {
    env,
    isDev,
    isProd,
    supabaseUrl: process.env.SUPABASE_URL || supabase.url,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || supabase.anonKey,
    apiUrl: process.env.STYRBY_API_URL || (isDev ? 'http://localhost:3000/api' : 'https://api.styrbyapp.com'),
    webUrl: process.env.STYRBY_WEB_URL || (isDev ? 'http://localhost:3000' : 'https://styrbyapp.com'),
    debug: process.env.STYRBY_DEBUG === 'true' || process.env.DEBUG === 'true' || isDev,
    logLevel: (process.env.STYRBY_LOG_LEVEL as EnvConfig['logLevel']) || (isDev ? 'debug' : 'info'),
  };
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Detected environment.
 */
export const ENV = detectEnvironment();

/**
 * Environment configuration.
 * Auto-detected based on environment.
 */
export const config: EnvConfig = buildConfig(ENV);

/**
 * Check if running in development.
 */
export const isDev = config.isDev;

/**
 * Check if running in production.
 */
export const isProd = config.isProd;

/**
 * Get a specific config value with type safety.
 */
export function getConfig<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
  return config[key];
}

/**
 * Override config for testing.
 * Only available in development.
 */
export function setTestConfig(overrides: Partial<EnvConfig>): void {
  if (isProd) {
    throw new Error('Cannot override config in production');
  }
  Object.assign(config, overrides);
}

export default config;
