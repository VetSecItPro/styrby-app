import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Security",
  description: "Styrby security architecture: E2E encryption, zero-knowledge design, key management, audit logging.",
};

/**
 * Security documentation page.
 */
export default function SecurityPage() {
  const { prev, next } = getPrevNext("/docs/security");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        Security
      </h1>
      <p className="mt-3 text-muted-foreground">
        Styrby is built on a zero-knowledge architecture. Your code and
        conversations are end-to-end encrypted. We cannot read them.
      </p>

      {/* E2E Encryption */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="end-to-end-encryption">
        End-to-End Encryption
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        All session messages are encrypted with TweetNaCl{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">box</code>{" "}
        (Curve25519 key exchange, XSalsa20 encryption, Poly1305 authentication)
        before leaving your machine.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-card p-4 text-sm font-mono text-foreground/75 ring-1 ring-border">
        <code>{`# Encryption flow:
1. CLI generates a 32-byte NaCl keypair during "styrby onboard"
2. Public key uploaded to Styrby and stored in the machine_keys table
3. Private key stored locally in ~/.styrby/config.json
4. Each message encrypted: nacl.box(msg, nonce, recipientPub, senderPriv)
   - nonce: 24 random bytes, unique per message
5. Server stores only the ciphertext
6. Dashboard and mobile decrypt locally using the device's private key`}</code>
      </pre>

      {/* Zero-Knowledge */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="zero-knowledge-architecture">
        Zero-Knowledge Architecture
      </h2>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="what-styrby-can-see">
        What Styrby can see
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Token counts (input, output, cache) for cost tracking</li>
        <li>Agent type and model name</li>
        <li>Session timestamps and duration</li>
        <li>Machine connection status</li>
      </ul>

      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="what-styrby-cannot-see">
        What Styrby cannot see
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Message content (prompts and responses)</li>
        <li>File contents or diffs</li>
        <li>Tool call arguments</li>
        <li>Your source code</li>
      </ul>
      <p className="mt-3 text-sm text-muted-foreground/70">
        Even if Styrby servers were compromised, attackers would only get
        encrypted blobs. The decryption keys exist only on your devices.
      </p>

      {/* Key Management */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="key-management">
        Key Management
      </h2>
      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="generation">Generation</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Keys are generated using{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          nacl.box.keyPair()
        </code>{" "}
        during the onboarding process. This produces a 32-byte public key and a
        32-byte secret key. The entropy source is the OS cryptographic random
        number generator.
      </p>

      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="storage">Storage</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The CLI stores the private key in{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          ~/.styrby/config.json
        </code>{" "}
        with 0600 file permissions (owner read/write only). On mobile, the key
        is stored in the device keychain (iOS Keychain / Android Keystore).
      </p>

      <h3 className="mt-4 text-base font-medium text-foreground/90 scroll-mt-20" id="re-pairing">Re-pairing</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        If you lose your private key (cleared browser storage, corrupted config,
        or new machine), run{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby onboard --force
        </code>{" "}
        to generate a new keypair and re-register. Sessions encrypted with the
        old key will no longer be decryptable on the new device.
      </p>

      {/* API Key Hashing */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="api-key-hashing">
        API Key Hashing
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        API keys are prefixed with{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">
          styrby_
        </code>{" "}
        and hashed with bcrypt (cost factor 12) before storage. When you make
        an API request, Styrby hashes the provided key and compares it against
        the stored hash. The raw key is never persisted. The plaintext key is
        returned only once at creation time.
      </p>

      {/* Rate Limiting */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="rate-limiting">
        Rate Limiting
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        All API endpoints are rate-limited using Upstash Redis with a sliding
        window algorithm. Limits are applied per user (authenticated routes)
        and per IP (public routes like login).
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Authentication endpoints: 10 requests per minute per IP</li>
        <li>API v1 endpoints: 100 requests per minute per API key</li>
        <li>Webhook management: 30 requests per minute per user</li>
      </ul>

      {/* Webhook Security */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="webhook-security">
        Webhook Security
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Webhook URLs must use HTTPS and must not target internal or private
        network addresses. The following are blocked:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>localhost and 127.0.0.1</li>
        <li>RFC 1918 private IPs (10.x.x.x, 172.16-31.x.x, 192.168.x.x)</li>
        <li>Link-local (169.254.x.x) and cloud metadata services</li>
      </ul>
      <p className="mt-2 text-sm text-muted-foreground/70">
        This prevents SSRF attacks where a webhook could be used to make
        requests against internal infrastructure.
      </p>

      {/* Audit Logging */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="audit-logging">
        Audit Logging
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Security-relevant events are recorded in the{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground/75">audit_log</code>{" "}
        table with BRIN indexing for efficient time-range queries. Logged events
        include:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
        <li>Login attempts (success and failure)</li>
        <li>Machine pairing and unpairing</li>
        <li>API key creation and revocation</li>
        <li>Webhook endpoint changes</li>
        <li>Permission approvals and denials</li>
        <li>Team member additions and removals</li>
        <li>Budget alert triggers</li>
      </ul>

      {/* Data Residency */}
      <h2 className="mt-10 text-xl font-semibold text-foreground scroll-mt-20" id="data-residency-and-compliance">
        Data Residency and Compliance
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Styrby infrastructure runs on Supabase (AWS) and Vercel. Database and
        auth are in the Supabase project region. Encrypted session data at rest
        uses AES-256 (Supabase default). In transit, all connections use TLS
        1.3.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        For compliance details, data processing agreements, and security
        certifications, see the{" "}
        <a
          href="/dpa"
          className="text-amber-500 underline underline-offset-2 hover:text-amber-400"
        >
          Data Processing Agreement
        </a>{" "}
        and{" "}
        <a
          href="/security"
          className="text-amber-500 underline underline-offset-2 hover:text-amber-400"
        >
          Security page
        </a>.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}
