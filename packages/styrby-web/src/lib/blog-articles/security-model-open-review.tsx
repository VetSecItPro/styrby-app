/**
 * Article: Our Security Model: An Open Technical Review
 * Category: company
 */
export default function SecurityModelOpenReview() {
  return (
    <>
      <p>
        This article publishes Styrby&apos;s security architecture for peer
        review. Security models should be transparent, not hidden behind a
        &quot;trust us&quot; statement. If you find a weakness, we want to
        know. Contact security@styrbyapp.com.
      </p>

      <h2>Threat Model</h2>
      <p>
        Styrby handles sensitive data: source code, agent conversations,
        permission decisions, and usage patterns. Our threat model assumes:
      </p>
      <ul>
        <li>
          <strong>Server compromise is possible.</strong> We design so that a
          server breach does not expose user data.
        </li>
        <li>
          <strong>Network traffic can be intercepted.</strong> All data is
          encrypted in transit (TLS 1.3) and at the application layer (E2E).
        </li>
        <li>
          <strong>Client devices can be lost or stolen.</strong> Secret keys
          are stored in system keychains with hardware-backed security where
          available.
        </li>
        <li>
          <strong>Insider threat is real.</strong> Even Styrby employees cannot
          read user session data because the server only stores ciphertext.
        </li>
      </ul>

      <h2>Encryption Architecture</h2>

      <h3>Data at Rest</h3>
      <table>
        <thead>
          <tr>
            <th>Data Type</th>
            <th>Storage</th>
            <th>Encryption</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Session messages</td>
            <td>Supabase (Postgres)</td>
            <td>TweetNaCl box (E2E, server sees ciphertext only)</td>
          </tr>
          <tr>
            <td>Cost records</td>
            <td>Supabase (Postgres)</td>
            <td>Plaintext (needed for server-side aggregation)</td>
          </tr>
          <tr>
            <td>User profiles</td>
            <td>Supabase (Postgres)</td>
            <td>Plaintext (email, preferences)</td>
          </tr>
          <tr>
            <td>Public keys</td>
            <td>Supabase (Postgres)</td>
            <td>Plaintext (public by definition)</td>
          </tr>
          <tr>
            <td>Secret keys</td>
            <td>Device keychain only</td>
            <td>System keychain encryption</td>
          </tr>
          <tr>
            <td>Audit logs</td>
            <td>Supabase (Postgres)</td>
            <td>Plaintext (needed for compliance queries)</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>What the server can see:</strong> cost amounts, token counts,
        agent types, session timestamps, user email, and audit events.
      </p>
      <p>
        <strong>What the server cannot see:</strong> source code, agent
        conversations, file contents, prompt text, or permission request
        details.
      </p>

      <h3>Data in Transit</h3>
      <ul>
        <li>All HTTP traffic: TLS 1.3</li>
        <li>WebSocket connections: WSS (TLS 1.3)</li>
        <li>Session message payloads: TweetNaCl box encryption inside TLS</li>
      </ul>
      <p>
        The double encryption (E2E inside TLS) is intentional. TLS protects
        against network-level interception. E2E protects against server-side
        access. Both are necessary for the threat model.
      </p>

      <h2>Authentication</h2>

      <h3>User Authentication</h3>
      <p>
        Supabase Auth handles user authentication with:
      </p>
      <ul>
        <li>Email/password with bcrypt hashing (12 rounds)</li>
        <li>OAuth (GitHub, Google) for social login</li>
        <li>JWT tokens with 1-hour expiry and automatic refresh</li>
        <li>Rate limiting on auth endpoints: 5 attempts per minute</li>
      </ul>

      <h3>CLI Authentication</h3>
      <p>
        The CLI authenticates using an OAuth-style flow:
      </p>
      <ol>
        <li>CLI generates a random state parameter and opens a browser URL</li>
        <li>User logs in via the web app</li>
        <li>Web app issues a session token and redirects to a local callback</li>
        <li>CLI receives the token and stores it in the system keychain</li>
        <li>Subsequent API calls use the stored token</li>
      </ol>
      <p>
        The state parameter prevents CSRF attacks during the auth flow. Tokens
        are stored in the system keychain, not in plaintext config files.
      </p>

      <h2>Authorization</h2>
      <p>
        All data access is controlled by PostgreSQL Row-Level Security (RLS)
        policies. Every table has policies that restrict access to the
        authenticated user&apos;s own data:
      </p>
      <pre>
        <code>{`-- Standard RLS pattern used across all tables
CREATE POLICY "Users access own data"
  ON sessions FOR ALL
  USING (user_id = (SELECT auth.uid()));

-- The (SELECT auth.uid()) pattern enables query plan caching,
-- which is a significant performance optimization over direct
-- auth.uid() calls.`}</code>
      </pre>
      <p>
        RLS policies are enforced at the database level, not the application
        level. Even if the application code constructs a bad query, the
        database rejects unauthorized access.
      </p>

      <h2>Infrastructure Security</h2>
      <ul>
        <li>
          <strong>Hosting:</strong> Vercel (web), Supabase (backend). Both
          SOC 2 Type II certified.
        </li>
        <li>
          <strong>Database:</strong> Supabase Postgres with encrypted storage
          and automated backups.
        </li>
        <li>
          <strong>Secrets management:</strong> All environment variables stored
          in Vercel/Supabase dashboards. No secrets in code or config files.
        </li>
        <li>
          <strong>Dependencies:</strong> Automated vulnerability scanning
          with <code>npm audit</code> in CI. Critical vulnerabilities block
          deployment.
        </li>
      </ul>

      <h2>What We Would Do Differently</h2>
      <p>
        Honest assessment of decisions we would reconsider:
      </p>
      <ul>
        <li>
          <strong>Forward secrecy.</strong> Our current encryption uses
          long-lived key pairs. A Double Ratchet protocol would provide forward
          secrecy, meaning a compromised key would not decrypt past messages.
          We may add this for the enterprise tier.
        </li>
        <li>
          <strong>Key rotation.</strong> We do not have an automated key
          rotation mechanism. Adding one requires either re-encrypting
          historical data or accepting split access. This is on the roadmap.
        </li>
        <li>
          <strong>Cost data encryption.</strong> Cost records are stored in
          plaintext for server-side aggregation. We could encrypt them and
          decrypt client-side, but this would prevent server-side budget
          checking. The tradeoff favors functionality over privacy for cost
          data specifically.
        </li>
      </ul>

      <h2>Reporting Vulnerabilities</h2>
      <p>
        If you find a security issue, email security@styrbyapp.com. We commit
        to acknowledging reports within 48 hours and providing a timeline for
        fixes within one week. We do not have a formal bug bounty program yet,
        but we will credit researchers in our changelog.
      </p>
      <p>
        The Styrby CLI source code is available on GitHub. We encourage
        security researchers to review the encryption implementation, the
        authentication flow, and the permission handling logic.
      </p>
    </>
  );
}
