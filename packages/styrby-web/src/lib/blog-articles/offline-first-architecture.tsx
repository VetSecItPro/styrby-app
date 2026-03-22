/**
 * Article: Offline-First Architecture: How Styrby Handles Lost Connections
 * Category: deep-dive
 */
export default function OfflineFirstArchitecture() {
  return (
    <>
      <p>
        Phones lose connectivity regularly: elevators, subways, buildings with
        poor signal, airplane mode. A mobile developer tool that shows a blank
        screen when offline is not useful to someone checking on an agent
        session during a commute. Styrby is designed to be useful when
        connectivity drops, not just when everything is online.
      </p>

      <h2>Why Offline-First for a Developer Tool</h2>
      <p>
        Offline-first means the app always has data to display. Cached sessions,
        cost summaries, and agent configurations are available immediately. When
        connectivity returns, changes sync automatically. The user experience
        should be identical whether you are on a fast connection or a spotty one.
      </p>

      <h2>Storage Layers</h2>

      <h3>Mobile: SQLite via Expo</h3>
      <p>
        The iOS app uses Expo SQLite for persistent local storage. SQLite is a
        single-file relational database that is fast, reliable, and widely
        deployed. Key tables mirrored locally:
      </p>
      <ul>
        <li>
          <code>sessions</code>: Metadata for recent sessions (agent, status,
          cost, timestamps)
        </li>
        <li>
          <code>session_messages</code>: Encrypted message content for
          bookmarked and recent sessions
        </li>
        <li>
          <code>cost_records</code>: Daily cost summaries for the dashboard
        </li>
        <li>
          <code>offline_command_queue</code>: Commands queued while offline
        </li>
      </ul>
      <p>
        The local database stores the last 30 days of session metadata and the
        last 7 days of message content. Older data is fetched on demand when
        online.
      </p>

      <h3>Web Dashboard: IndexedDB</h3>
      <p>
        The web dashboard uses IndexedDB for offline caching. The schema mirrors
        the mobile SQLite structure. IndexedDB is asynchronous and has larger
        storage limits than localStorage, making it suitable for caching session
        data.
      </p>

      <h2>The Offline Command Queue</h2>
      <p>
        When you are offline, certain actions queue instead of failing:
      </p>
      <ul>
        <li>Approving or denying a pending permission request</li>
        <li>Bookmarking a session</li>
        <li>Adjusting budget alert thresholds</li>
        <li>Updating notification preferences</li>
      </ul>
      <p>
        These actions are stored in the <code>offline_command_queue</code>{" "}
        table with a timestamp and operation type. When connectivity returns,
        the queue drains in order.
      </p>
      <pre>
        <code>{`// Simplified queue structure
{
  id: "cmd_abc123",
  operation: "permission_approve",
  payload: { sessionId: "ses_xyz", requestId: "req_456" },
  createdAt: "2026-03-15T14:30:00Z",
  status: "pending"  // pending → syncing → synced | failed
}`}</code>
      </pre>

      <h2>Sync Protocol</h2>
      <p>
        When the device comes back online, synchronization happens in three
        phases:
      </p>
      <ol>
        <li>
          <strong>Drain the command queue.</strong> Pending commands are sent
          to the server in chronological order. If a command fails (e.g., the
          permission request has already timed out), it is marked as failed
          with the reason, and the next command proceeds.
        </li>
        <li>
          <strong>Pull fresh data.</strong> The app requests updates since the
          last sync timestamp. The server responds with new sessions, updated
          cost records, and any configuration changes made from other devices.
        </li>
        <li>
          <strong>Resolve conflicts.</strong> If the same record was modified
          on multiple devices while both were offline, server wins. Local
          changes that conflict are discarded with a notification to the user.
        </li>
      </ol>
      <p>
        After the initial catch-up, Supabase Realtime handles ongoing updates
        through WebSocket subscriptions. New session data, cost updates, and
        permission requests push to the device as they happen.
      </p>

      <h2>Conflict Resolution: Server Wins</h2>
      <p>
        Styrby uses a simple conflict resolution strategy: the server is always
        right. This works because most Styrby data flows in one direction (CLI
        to server to mobile). The rare conflict scenario is when two devices
        modify the same configuration while both are offline. In practice, this
        almost never happens because configuration changes are infrequent and
        typically happen from a single device.
      </p>
      <p>
        More sophisticated conflict resolution (CRDTs, operational transforms)
        would add complexity without solving a real problem. Server-wins is the
        right tradeoff for this use case.
      </p>

      <h2>What Does Not Work Offline</h2>
      <p>
        Offline mode has clear limitations:
      </p>
      <ul>
        <li>
          <strong>Live session monitoring.</strong> You cannot watch a running
          agent session without connectivity. The session continues on your
          workstation; you just cannot see it until you reconnect.
        </li>
        <li>
          <strong>Cost tracking.</strong> Cost data updates when new data syncs.
          Offline, you see the last-known costs.
        </li>
        <li>
          <strong>Permission approvals are delayed.</strong> Queued approvals
          are sent when you reconnect. If the agent is waiting for approval, it
          blocks until the queue drains. For time-sensitive permissions, offline
          mode means the agent waits.
        </li>
      </ul>

      <h2>Testing Offline Behavior</h2>
      <p>
        The Styrby mobile app has a developer mode that simulates offline
        conditions. Toggle airplane mode in the app settings to test how the UI
        behaves without connectivity, verify that the command queue fills
        correctly, and confirm that sync works when you toggle back online.
      </p>
    </>
  );
}
