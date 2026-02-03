/**
 * Persistence Layer
 *
 * Handles persistent storage for CLI state, sessions, and credentials.
 *
 * WHY: Stub module for Happy Coder's persistence system.
 * Will be integrated with Supabase for remote storage and
 * local SQLite for offline caching.
 *
 * @module persistence
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { CONFIG_DIR, ensureConfigDir } from './configuration';
import { logger } from '@/ui/logger';

// ============================================================================
// Persisted Data (Auth & Machine Info)
// ============================================================================

/**
 * Persisted data structure for authentication and machine info.
 */
export interface PersistedData {
  /** User ID from Supabase auth */
  userId?: string;
  /** Access token for Supabase */
  accessToken?: string;
  /** Refresh token for Supabase */
  refreshToken?: string;
  /** Unique machine identifier */
  machineId?: string;
  /** Machine name (hostname) */
  machineName?: string;
  /** When the user authenticated */
  authenticatedAt?: string;
  /** When the machine was paired */
  pairedAt?: string;
}

const DATA_FILE = path.join(CONFIG_DIR, 'data.json');

/**
 * Save persisted data to disk.
 *
 * @param data - Data to persist
 */
export function savePersistedData(data: PersistedData): void {
  ensureConfigDir();
  const existing = loadPersistedData() || {};
  const merged = { ...existing, ...data };
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  logger.debug('Persisted data saved');
}

/**
 * Load persisted data from disk.
 *
 * @returns Persisted data or null if not found
 */
export function loadPersistedData(): PersistedData | null {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(content) as PersistedData;
    }
  } catch (error) {
    logger.error('Failed to load persisted data', { error });
  }
  return null;
}

/**
 * Clear all persisted data.
 */
export function clearPersistedData(): void {
  try {
    if (fs.existsSync(DATA_FILE)) {
      fs.unlinkSync(DATA_FILE);
      logger.debug('Persisted data cleared');
    }
  } catch (error) {
    logger.error('Failed to clear persisted data', { error });
  }
}

// ============================================================================
// Sessions
// ============================================================================

/**
 * Session metadata stored locally
 */
export interface StoredSession {
  sessionId: string;
  agentType: 'claude' | 'codex' | 'gemini';
  projectPath: string;
  createdAt: string;
  lastActivityAt: string;
  status: string;
}

/**
 * Path to sessions storage
 */
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

/**
 * Ensure sessions directory exists.
 */
function ensureSessionsDir(): void {
  ensureConfigDir();
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Save a session to local storage.
 *
 * @param session - Session to save
 */
export function saveSession(session: StoredSession): void {
  ensureSessionsDir();
  const filePath = path.join(SESSIONS_DIR, `${session.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  logger.debug('Session saved', { sessionId: session.sessionId });
}

/**
 * Load a session from local storage.
 *
 * @param sessionId - Session ID to load
 * @returns Session or null if not found
 */
export function loadSession(sessionId: string): StoredSession | null {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as StoredSession;
    }
  } catch (error) {
    logger.error('Failed to load session', { sessionId, error });
  }
  return null;
}

/**
 * Delete a session from local storage.
 *
 * @param sessionId - Session ID to delete
 */
export function deleteSession(sessionId: string): void {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.debug('Session deleted', { sessionId });
    }
  } catch (error) {
    logger.error('Failed to delete session', { sessionId, error });
  }
}

/**
 * List all stored sessions.
 *
 * @returns Array of stored sessions
 */
export function listSessions(): StoredSession[] {
  ensureSessionsDir();
  const sessions: StoredSession[] = [];
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const sessionId = file.replace('.json', '');
        const session = loadSession(sessionId);
        if (session) {
          sessions.push(session);
        }
      }
    }
  } catch (error) {
    logger.error('Failed to list sessions', { error });
  }
  return sessions.sort((a, b) =>
    new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );
}

/**
 * Get the most recent session for a project path.
 *
 * @param projectPath - Project path to search for
 * @returns Most recent session or null
 */
export function getRecentSessionForProject(projectPath: string): StoredSession | null {
  const sessions = listSessions();
  return sessions.find(s => s.projectPath === projectPath) || null;
}

/**
 * Clear all stored sessions.
 */
export function clearAllSessions(): void {
  ensureSessionsDir();
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(SESSIONS_DIR, file));
    }
    logger.debug('All sessions cleared');
  } catch (error) {
    logger.error('Failed to clear sessions', { error });
  }
}

/**
 * Default export for compatibility
 */
export default {
  // Auth & machine data
  savePersistedData,
  loadPersistedData,
  clearPersistedData,
  // Sessions
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  getRecentSessionForProject,
  clearAllSessions,
};
