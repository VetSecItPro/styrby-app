/**
 * Article: End-to-End Encryption for AI Coding Sessions
 * Category: deep-dive
 */
export default function E2eEncryptionAiCodingSessions() {
  return (
    <>
      <p>
        Your AI coding session contains more than just your question. It
        contains source code, file paths, database schemas, and occasionally
        credentials that slip into context. Styrby encrypts all of this before
        it leaves your machine. This article explains the encryption
        architecture, the key exchange protocol, and what the server can and
        cannot see.
      </p>

      <h2>Why Zero-Knowledge Matters for Code</h2>
      <p>
        AI agent sessions are not casual chat messages. They contain
        proprietary source code, API designs, and sometimes secrets a developer
        accidentally includes in context. A server breach that exposes these
        sessions could leak intellectual property or credentials.
      </p>
      <p>
        Zero-knowledge architecture means the server stores only ciphertext.
        Even if someone compromises the server, they get encrypted blobs that
        are useless without the client-side keys. This is the same principle
        behind Signal and ProtonMail, applied to coding sessions.
      </p>

      <h2>The Encryption Stack</h2>
      <p>
        Styrby uses TweetNaCl (pronounced &quot;tweet salt&quot;), a compact,
        audited cryptography library. Specifically, it uses the{" "}
        <code>nacl.box</code> construction, which combines:
      </p>
      <ul>
        <li>
          <strong>Curve25519</strong> for key exchange (Diffie-Hellman on an
          elliptic curve)
        </li>
        <li>
          <strong>XSalsa20</strong> for symmetric encryption (stream cipher)
        </li>
        <li>
          <strong>Poly1305</strong> for message authentication (MAC)
        </li>
      </ul>
      <p>
        This combination provides authenticated encryption. An attacker cannot
        decrypt the message (confidentiality) or modify it without detection
        (integrity). Both properties matter: confidentiality keeps code private,
        integrity prevents tampering with permission responses.
      </p>

      <h2>Key Generation and Exchange</h2>
      <p>
        When you set up Styrby on a new device, the CLI generates a
        Curve25519 key pair:
      </p>
      <pre>
        <code>{`// Key generation happens once per device
const keyPair = nacl.box.keyPair();
// keyPair.publicKey  → 32 bytes, stored on server
// keyPair.secretKey  → 32 bytes, stored ONLY on device`}</code>
      </pre>
      <p>
        The public key is uploaded to Styrby&apos;s <code>machine_keys</code>{" "}
        table in Supabase. The secret key never leaves the device. It is
        stored in the system keychain (macOS Keychain, Windows Credential
        Manager, or Linux Secret Service).
      </p>
      <p>
        When your mobile app connects to a CLI session, the two devices
        exchange public keys. Each device then computes a shared secret using
        its own secret key and the other device&apos;s public key:
      </p>
      <pre>
        <code>{`// On the CLI side
const sharedKey = nacl.box.before(mobilePublicKey, cliSecretKey);

// On the mobile side
const sharedKey = nacl.box.before(cliPublicKey, mobileSecretKey);

// Both derive the same shared key (Diffie-Hellman property)`}</code>
      </pre>

      <h2>Message Encryption Flow</h2>
      <p>
        Every session message goes through this process before transmission:
      </p>
      <ol>
        <li>
          The CLI captures agent output (code, explanations, permission
          requests).
        </li>
        <li>
          A random 24-byte nonce is generated for this message. Nonces are
          never reused.
        </li>
        <li>
          The message is encrypted using <code>nacl.box.after</code> with the
          shared key and nonce.
        </li>
        <li>
          The encrypted message and nonce are sent to the server together.
        </li>
        <li>
          The server stores both in the <code>session_messages</code> table
          without any ability to decrypt them.
        </li>
        <li>
          The receiving device retrieves the ciphertext and nonce, then
          decrypts locally using the same shared key.
        </li>
      </ol>
      <pre>
        <code>{`// Encryption (sender side)
const nonce = nacl.randomBytes(24);
const encrypted = nacl.box.after(
  messageBytes,
  nonce,
  sharedKey
);

// Send { nonce, encrypted } to server

// Decryption (receiver side)
const decrypted = nacl.box.open.after(
  encrypted,
  nonce,
  sharedKey
);`}</code>
      </pre>

      <h2>What the Server Sees</h2>
      <p>The Styrby server has access to:</p>
      <ul>
        <li>Encrypted ciphertext (useless without keys)</li>
        <li>Message timestamps</li>
        <li>Token counts (for cost tracking, computed client-side before encryption)</li>
        <li>Session metadata: agent type, status, project name (configurable)</li>
      </ul>
      <p>The server does NOT have access to:</p>
      <ul>
        <li>Source code</li>
        <li>Agent prompts or responses</li>
        <li>File contents</li>
        <li>Permission request details (only the approval/denial result)</li>
        <li>Secret keys</li>
      </ul>

      <h2>The Key Loss Problem</h2>
      <p>
        Zero-knowledge encryption has a real downside: if you lose your device
        keys, your encrypted session history becomes unrecoverable. Styrby
        cannot help you because Styrby does not have the keys.
      </p>
      <p>
        Mitigation: Styrby supports registering multiple devices. Your mobile
        and your workstation each have their own key pairs and can both decrypt
        session data. Losing one device does not lose your history, as long as
        the other device still has its keys. Register at least two devices.
      </p>

      <h2>Why TweetNaCl Over WebCrypto or libsodium</h2>
      <p>
        TweetNaCl is a deliberate choice. It is a single-file, audited
        implementation with no dependencies. The entire library is about 7KB
        minified, which matters for a CLI tool where dependency weight and
        supply chain risk are real concerns.
      </p>
      <p>
        WebCrypto is browser-native but has an inconsistent API across
        environments and does not work in all Node.js versions without
        polyfills. libsodium is more feature-rich but adds a larger dependency.
        For the specific operations Styrby needs (box encryption with
        Curve25519), TweetNaCl provides exactly the right primitives with
        minimal overhead.
      </p>

      <h2>Verification</h2>
      <p>
        The encryption implementation is open for review in the Styrby CLI
        source code. If you want to verify that messages are actually encrypted
        before transmission, inspect the network traffic: every message payload
        is base64-encoded ciphertext, not readable JSON.
      </p>
    </>
  );
}
