/**
 * Article: Building Offline-First React Native Apps with Expo SQLite
 * Category: technical
 */
export default function OfflineFirstReactNativeExpoSqlite() {
  return (
    <>
      <p>
        Offline-first means the app works without network connectivity and
        syncs when it comes back. This article walks through the approach
        Styrby uses: Expo SQLite for local persistence, a command queue for
        offline actions, and a sync protocol for reconciliation. The code
        examples are from our actual implementation.
      </p>

      <h2>Setting Up Expo SQLite</h2>
      <p>
        Expo SQLite ships with Expo SDK 54+. It provides synchronous and
        asynchronous APIs for SQLite operations. For offline-first apps, use
        the async API to avoid blocking the UI thread.
      </p>
      <pre>
        <code>{`import * as SQLite from "expo-sqlite";

// Open (or create) the database
const db = await SQLite.openDatabaseAsync("styrby.db");

// Create tables on first launch
await db.execAsync(\`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    project TEXT,
    total_cost_usd REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS offline_queue (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_updated
    ON sessions(updated_at);

  CREATE INDEX IF NOT EXISTS idx_queue_status
    ON offline_queue(status);
\`);`}</code>
      </pre>

      <h2>The Data Access Layer</h2>
      <p>
        Wrap SQLite operations in a repository pattern so the rest of the app
        does not interact with SQL directly:
      </p>
      <pre>
        <code>{`interface Session {
  id: string;
  agentType: string;
  status: string;
  project: string | null;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

class SessionRepository {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async getAll(): Promise<Session[]> {
    return this.db.getAllAsync<Session>(
      "SELECT * FROM sessions ORDER BY updated_at DESC"
    );
  }

  async getById(id: string): Promise<Session | null> {
    return this.db.getFirstAsync<Session>(
      "SELECT * FROM sessions WHERE id = ?",
      [id]
    );
  }

  async upsert(session: Session): Promise<void> {
    await this.db.runAsync(
      \`INSERT INTO sessions (id, agent_type, status, project,
        total_cost_usd, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        total_cost_usd = excluded.total_cost_usd,
        updated_at = excluded.updated_at,
        synced_at = excluded.synced_at\`,
      [
        session.id, session.agentType, session.status,
        session.project, session.totalCostUsd,
        session.createdAt, session.updatedAt, session.syncedAt,
      ]
    );
  }
}`}</code>
      </pre>

      <h2>The Offline Command Queue</h2>
      <p>
        When the user performs an action while offline, it goes into a queue
        instead of failing:
      </p>
      <pre>
        <code>{`import { nanoid } from "nanoid";

class OfflineQueue {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async enqueue(operation: string, payload: object): Promise<string> {
    const id = nanoid();
    await this.db.runAsync(
      \`INSERT INTO offline_queue (id, operation, payload, created_at, status)
       VALUES (?, ?, ?, ?, 'pending')\`,
      [id, operation, JSON.stringify(payload), new Date().toISOString()]
    );
    return id;
  }

  async getPending(): Promise<QueueItem[]> {
    return this.db.getAllAsync<QueueItem>(
      "SELECT * FROM offline_queue WHERE status = 'pending' ORDER BY created_at ASC"
    );
  }

  async markSynced(id: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE offline_queue SET status = 'synced' WHERE id = ?",
      [id]
    );
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE offline_queue SET status = 'failed' WHERE id = ?",
      [id]
    );
  }

  async cleanup(): Promise<void> {
    // Remove synced items older than 7 days
    await this.db.runAsync(
      \`DELETE FROM offline_queue
       WHERE status = 'synced'
       AND created_at < datetime('now', '-7 days')\`
    );
  }
}`}</code>
      </pre>
      <p>
        Usage from a UI action:
      </p>
      <pre>
        <code>{`async function bookmarkSession(sessionId: string, label: string) {
  if (isOnline) {
    // Direct API call
    await api.bookmarkSession(sessionId, label);
  } else {
    // Queue for later
    await offlineQueue.enqueue("bookmark_session", { sessionId, label });
    // Update local state immediately for responsive UI
    await sessionRepo.updateBookmark(sessionId, label);
  }
}`}</code>
      </pre>

      <h2>Sync on Reconnect</h2>
      <p>
        When connectivity returns, the sync process runs in three phases:
      </p>
      <pre>
        <code>{`import NetInfo from "@react-native-community/netinfo";

// Listen for connectivity changes
NetInfo.addEventListener((state) => {
  if (state.isConnected && !wasPreviouslyConnected) {
    syncManager.performSync();
  }
  wasPreviouslyConnected = state.isConnected ?? false;
});

class SyncManager {
  async performSync(): Promise<void> {
    // Phase 1: Drain the offline queue
    const pending = await offlineQueue.getPending();
    for (const item of pending) {
      try {
        await this.executeQueueItem(item);
        await offlineQueue.markSynced(item.id);
      } catch (error) {
        // Item-level failure does not block the queue
        await offlineQueue.markFailed(item.id, String(error));
      }
    }

    // Phase 2: Pull server updates
    const lastSync = await this.getLastSyncTimestamp();
    const updates = await api.getUpdatedSince(lastSync);

    for (const session of updates.sessions) {
      await sessionRepo.upsert({
        ...session,
        syncedAt: new Date().toISOString(),
      });
    }

    // Phase 3: Update sync timestamp
    await this.setLastSyncTimestamp(new Date().toISOString());

    // Cleanup old synced queue items
    await offlineQueue.cleanup();
  }

  private async executeQueueItem(item: QueueItem): Promise<void> {
    const payload = JSON.parse(item.payload);
    switch (item.operation) {
      case "bookmark_session":
        await api.bookmarkSession(payload.sessionId, payload.label);
        break;
      case "approve_permission":
        await api.approvePermission(payload.sessionId, payload.requestId);
        break;
      // ... other operations
    }
  }
}`}</code>
      </pre>

      <h2>Conflict Resolution</h2>
      <p>
        Styrby uses server-wins conflict resolution. When a local record and a
        server record for the same entity have different values, the server
        version replaces the local one. This works because:
      </p>
      <ul>
        <li>
          Most data flows CLI to server to mobile. Conflicts are rare.
        </li>
        <li>
          Configuration changes happen infrequently and typically from one
          device.
        </li>
        <li>
          Implementing CRDTs or operational transforms adds complexity that is
          not justified by the frequency of conflicts in this use case.
        </li>
      </ul>

      <h2>Data Retention</h2>
      <p>
        The local database should not grow indefinitely. Styrby keeps 30 days
        of session metadata and 7 days of message content locally. Older data
        is fetched on demand from the server when online.
      </p>
      <pre>
        <code>{`// Run periodically (e.g., on app launch)
async function pruneLocalData(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.runAsync(
    "DELETE FROM session_messages WHERE created_at < datetime('now', '-7 days')"
  );
  await db.runAsync(
    "DELETE FROM sessions WHERE created_at < datetime('now', '-30 days')"
  );
}`}</code>
      </pre>

      <h2>Testing Offline Behavior</h2>
      <p>
        Test offline scenarios by mocking the network state:
      </p>
      <ul>
        <li>Enqueue actions while &quot;offline&quot;</li>
        <li>Verify local state updates immediately</li>
        <li>Toggle to &quot;online&quot; and verify the queue drains</li>
        <li>Introduce server errors and verify failed items are handled</li>
        <li>Verify conflict resolution picks the server version</li>
      </ul>
      <p>
        Expo&apos;s testing tools let you simulate network conditions. In
        development, airplane mode on a physical device gives the most realistic
        test environment.
      </p>
    </>
  );
}
