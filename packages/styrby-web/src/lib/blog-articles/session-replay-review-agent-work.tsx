/**
 * Article: Session Replay: Reviewing What Your AI Agent Did
 * Category: deep-dive
 */
export default function SessionReplayReviewAgentWork() {
  return (
    <>
      <p>
        After a long agent session, you need to understand what happened. What
        files were changed? How much did it cost? Did the agent take any
        unexpected actions? Session replay is how Styrby provides that
        visibility without compromising encryption.
      </p>

      <h2>How Encrypted Replay Works</h2>
      <p>
        Every session message is stored encrypted on the server. When you open
        a past session in the Styrby app or web dashboard, the messages are
        downloaded as ciphertext and decrypted locally on your device using
        your stored key pair.
      </p>
      <p>
        Replay works only on devices that have the encryption keys for that
        session. If you started a session from your workstation and want to
        review it on your phone, both devices need to be registered with Styrby,
        which happens automatically during setup. The replay loads in
        chronological order, showing each exchange between you, the agent, and
        any tool executions. Each message displays its token count and cost
        alongside the content.
      </p>

      <h2>Filtering and Search</h2>
      <p>
        With dozens or hundreds of sessions over a month, finding the right one
        matters. Styrby supports filtering by:
      </p>
      <ul>
        <li>
          <strong>Agent.</strong> Show only Claude sessions, only Codex
          sessions, or any combination.
        </li>
        <li>
          <strong>Date range.</strong> Last 24 hours, last week, or custom
          range.
        </li>
        <li>
          <strong>Cost.</strong> Sessions above $5, above $10, or custom
          threshold. Useful for investigating expensive sessions.
        </li>
        <li>
          <strong>Project.</strong> Filter by the project directory the session
          was run in.
        </li>
        <li>
          <strong>Status.</strong> Completed, errored, or still running.
        </li>
      </ul>
      <p>
        Full-text search within session content happens client-side after
        decryption. The server cannot search encrypted content, so search
        requires downloading and decrypting the session first. For large
        session histories, this means search is slower than a server-side
        query. The tradeoff is privacy: your search terms never leave your
        device.
      </p>

      <h2>Bookmarking Sessions</h2>
      <p>
        Some sessions are worth keeping for reference: a good architecture
        discussion, a complex debugging session that solved a hard problem, or
        a session that demonstrates a useful technique.
      </p>
      <p>
        Bookmarks add a session to your saved list with an optional label.
        Bookmark metadata (session ID, label, timestamp) is stored on the
        server. The session content itself remains encrypted.
      </p>
      <pre>
        <code>{`# Bookmark from the CLI
styrby session bookmark --id ses_abc123 --label "Auth refactor approach"

# List bookmarks
styrby session bookmarks
# ID            Label                    Agent    Date         Cost
# ses_abc123    Auth refactor approach   claude   2026-03-15   $4.20
# ses_def456    Perf debugging           codex    2026-03-12   $2.10`}</code>
      </pre>

      <h2>Cost Breakdown per Session</h2>
      <p>
        Each session summary shows a cost breakdown:
      </p>
      <ul>
        <li>Total cost</li>
        <li>Input tokens and cost</li>
        <li>Output tokens and cost</li>
        <li>Cache tokens and savings</li>
        <li>Model used</li>
        <li>Session duration</li>
        <li>Number of turns (exchanges)</li>
      </ul>
      <p>
        This breakdown helps identify which sessions are cost-efficient. A
        session that spent 40 turns retrying a failing test at $0.50 per turn
        is a clear signal to improve the test setup or switch to a cheaper
        model for iterative work.
      </p>

      <h2>Reviewing Permission Decisions</h2>
      <p>
        The replay timeline highlights permission requests and your responses.
        Each permission event shows:
      </p>
      <ul>
        <li>What the agent requested</li>
        <li>The risk classification</li>
        <li>Whether you approved or denied</li>
        <li>How long the agent waited for your response</li>
      </ul>
      <p>
        This is useful for post-session security review, especially for
        overnight sessions where you may have approved dozens of permissions
        from your phone without full context.
      </p>

      <h2>Export</h2>
      <p>
        Sessions can be exported as JSON for external processing or archival.
        The export decrypts the session locally and writes a JSON file to your
        device. The exported file is plaintext, so handle it with the same care
        you would give source code.
      </p>
      <pre>
        <code>{`# Export a session to JSON
styrby session export --id ses_abc123 --output ./session-export.json`}</code>
      </pre>
      <p>
        Export is a client-side operation. The server sends encrypted data,
        your device decrypts it, and the plaintext JSON is written locally.
        Nothing unencrypted touches the network.
      </p>

      <h2>Limitations</h2>
      <p>
        Session replay has inherent limitations due to the zero-knowledge
        architecture:
      </p>
      <ul>
        <li>
          Search is client-side only. Large session histories take time to
          search because each session must be decrypted first.
        </li>
        <li>
          Lost keys mean lost sessions. If both of your registered devices lose
          their keys, those sessions are permanently inaccessible.
        </li>
        <li>
          Live session replay is not supported. You can review sessions after
          they complete, but you cannot watch a live session from the replay
          interface. Use the live monitoring view for that.
        </li>
      </ul>
    </>
  );
}
