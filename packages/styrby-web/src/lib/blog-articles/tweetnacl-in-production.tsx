/**
 * Article: TweetNaCl in Production: Building E2E Encrypted Messaging
 * Category: technical
 */
export default function TweetNaclInProduction() {
  return (
    <>
      <p>
        Styrby uses TweetNaCl for end-to-end encryption of coding session data.
        This article covers why we chose TweetNaCl, how key management works in
        practice, the performance characteristics we measured, and the mistakes
        we made along the way.
      </p>

      <h2>Why TweetNaCl</h2>
      <p>
        The requirements were specific: authenticated encryption that works in
        Node.js (CLI), React Native (mobile), and the browser (web dashboard).
        The library needed to be small, well-audited, and have zero
        dependencies.
      </p>
      <p>
        We evaluated three options:
      </p>
      <table>
        <thead>
          <tr>
            <th>Library</th>
            <th>Size (min)</th>
            <th>Dependencies</th>
            <th>Audit Status</th>
            <th>Platforms</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>tweetnacl</td>
            <td>~7KB</td>
            <td>0</td>
            <td>Formally verified</td>
            <td>Node, browser, RN</td>
          </tr>
          <tr>
            <td>libsodium.js</td>
            <td>~180KB</td>
            <td>0</td>
            <td>Audited</td>
            <td>Node, browser, RN (with effort)</td>
          </tr>
          <tr>
            <td>WebCrypto API</td>
            <td>Native</td>
            <td>0</td>
            <td>Platform-dependent</td>
            <td>Browser, Node 15+, no RN</td>
          </tr>
        </tbody>
      </table>
      <p>
        TweetNaCl won on three criteria: smallest size (important for CLI
        install speed), zero dependencies (supply chain security), and
        cross-platform compatibility without polyfills.
      </p>
      <p>
        The formal verification is a meaningful advantage. TweetNaCl is a
        JavaScript port of the NaCl library by Daniel J. Bernstein, and the
        JavaScript implementation has been verified against the reference
        implementation. This is a stronger guarantee than &quot;we wrote
        tests.&quot;
      </p>

      <h2>Key Management Architecture</h2>
      <p>
        Each device (CLI workstation and mobile phone) generates a Curve25519
        key pair on first setup:
      </p>
      <pre>
        <code>{`import nacl from "tweetnacl";

// Generate once, store securely
const keyPair = nacl.box.keyPair();

// Public key: 32 bytes, uploaded to server
// Secret key: 32 bytes, stored in system keychain ONLY`}</code>
      </pre>

      <h3>Key Storage</h3>
      <ul>
        <li>
          <strong>macOS CLI:</strong> Keychain Services via{" "}
          <code>security</code> CLI
        </li>
        <li>
          <strong>Linux CLI:</strong> Secret Service API (libsecret) or
          encrypted file in <code>~/.config/styrby/</code>
        </li>
        <li>
          <strong>iOS:</strong> Expo SecureStore (backed by Keychain)
        </li>
        <li>
          <strong>Web:</strong> IndexedDB with non-exportable CryptoKey
          wrapping (browser-session scoped)
        </li>
      </ul>

      <h3>Key Exchange</h3>
      <p>
        When the CLI and mobile app establish a session, they exchange public
        keys through the Styrby server. The server facilitates the exchange but
        never sees the secret keys. The shared secret is computed independently
        on each device:
      </p>
      <pre>
        <code>{`// Both sides compute the same shared key
// CLI side:
const shared = nacl.box.before(mobilePublicKey, cliSecretKey);

// Mobile side:
const shared = nacl.box.before(cliPublicKey, mobileSecretKey);

// Diffie-Hellman: both produce identical 32-byte shared keys`}</code>
      </pre>

      <h2>Encryption and Decryption</h2>
      <p>
        We use <code>nacl.box.after</code> (the precomputed variant) for message
        encryption. This avoids recomputing the shared secret for every message:
      </p>
      <pre>
        <code>{`import nacl from "tweetnacl";
import { encodeUTF8, decodeUTF8 } from "tweetnacl-util";

function encrypt(message: string, sharedKey: Uint8Array): {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  const nonce = nacl.randomBytes(nacl.box.nonceLength); // 24 bytes
  const messageBytes = decodeUTF8(message);
  const ciphertext = nacl.box.after(messageBytes, nonce, sharedKey);

  if (!ciphertext) throw new Error("Encryption failed");
  return { nonce, ciphertext };
}

function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  sharedKey: Uint8Array
): string {
  const decrypted = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!decrypted) throw new Error("Decryption failed: invalid key or tampered data");
  return encodeUTF8(decrypted);
}`}</code>
      </pre>

      <h2>Performance Characteristics</h2>
      <p>
        We benchmarked TweetNaCl on the three target platforms:
      </p>
      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Message Size</th>
            <th>Node.js (M2 Mac)</th>
            <th>React Native (iPhone 15)</th>
            <th>Chrome (M2 Mac)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Key generation</td>
            <td>N/A</td>
            <td>0.02ms</td>
            <td>0.1ms</td>
            <td>0.03ms</td>
          </tr>
          <tr>
            <td>Encrypt</td>
            <td>1KB</td>
            <td>0.05ms</td>
            <td>0.3ms</td>
            <td>0.08ms</td>
          </tr>
          <tr>
            <td>Encrypt</td>
            <td>100KB</td>
            <td>2.1ms</td>
            <td>8.5ms</td>
            <td>3.2ms</td>
          </tr>
          <tr>
            <td>Encrypt</td>
            <td>1MB</td>
            <td>18ms</td>
            <td>72ms</td>
            <td>28ms</td>
          </tr>
          <tr>
            <td>Decrypt</td>
            <td>1KB</td>
            <td>0.04ms</td>
            <td>0.25ms</td>
            <td>0.07ms</td>
          </tr>
          <tr>
            <td>Decrypt</td>
            <td>100KB</td>
            <td>1.8ms</td>
            <td>7.2ms</td>
            <td>2.8ms</td>
          </tr>
        </tbody>
      </table>
      <p>
        For typical session messages (1-10KB), encryption adds less than 1ms on
        any platform. Even large messages (code files with full context) encrypt
        in under 20ms on the CLI. The performance overhead is negligible
        compared to network latency.
      </p>

      <h2>Lessons Learned</h2>

      <h3>1. Nonce Management Is Critical</h3>
      <p>
        Reusing a nonce with the same key breaks the security of XSalsa20.
        We use <code>nacl.randomBytes(24)</code> for every message. With a
        24-byte nonce space, the probability of collision is negligible even at
        billions of messages.
      </p>

      <h3>2. Error Messages Must Not Leak Information</h3>
      <p>
        Our initial implementation returned different error messages for
        &quot;wrong key&quot; and &quot;tampered data.&quot; This is an oracle
        that helps attackers distinguish failure modes. Both cases now return
        the same generic error.
      </p>

      <h3>3. Key Rotation Is Hard</h3>
      <p>
        We planned for key rotation but have not implemented it yet. Rotating
        keys requires re-encrypting historical messages or accepting that old
        messages become inaccessible with new keys. For now, keys persist for
        the lifetime of the device registration. This is a known limitation.
      </p>

      <h3>4. React Native Gotchas</h3>
      <p>
        TweetNaCl works in React Native but relies on{" "}
        <code>crypto.getRandomValues</code> for secure random number generation.
        Expo provides this, but some bare React Native setups require a
        polyfill. We document this in the setup guide.
      </p>

      <h2>Open Questions</h2>
      <p>
        We are still evaluating forward secrecy. The current design uses
        long-lived key pairs. A Double Ratchet protocol (like Signal uses) would
        provide forward secrecy but adds significant complexity. For coding
        sessions where the threat model is server compromise rather than active
        MITM, the current approach provides adequate security. We may revisit
        this for the enterprise tier.
      </p>
    </>
  );
}
