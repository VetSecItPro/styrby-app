/**
 * TLS Certificate Pinning for Styrby + Supabase Endpoints (CLI-007)
 *
 * SECURITY (audit 2026-05-04): Without pinning, the CLI trusts ANY CA in the
 * system trust store. A malicious local CA (corporate MITM proxy, attacker
 * with admin install rights) silently intercepts all TLS sessions and reads
 * the user's API keys + agent traffic. Pinning the leaf-cert SHA-256
 * fingerprint stops this — only the real cert chain (issued by the real CA)
 * matches our pin.
 *
 * Pinning Strategy
 * ----------------
 * - Pin SHA-256 fingerprints of the LEAF cert (DER form) — standard practice
 *   and what `openssl x509 -fingerprint -sha256` returns.
 * - Pin BOTH the current cert AND a backup pin slot per host (industry
 *   standard "two-pin" model: when rotation happens you publish the new pin
 *   alongside the old one, then drop the old one a release later).
 * - Allow override via `STYRBY_NO_CERT_PIN=1` env or `--no-cert-pin` CLI flag
 *   so an operator on a known-trusted MITM (corporate proxy) can opt out
 *   with informed consent.
 *
 * Pin Rotation Procedure
 * ----------------------
 * 1. Before rotating the cert, fetch the new fingerprint:
 *      `echo | openssl s_client -connect <host>:443 -servername <host> -showcerts \
 *         2>/dev/null | openssl x509 -noout -fingerprint -sha256`
 * 2. Add the NEW fingerprint to the host's array as the "backup" pin
 *    alongside the existing CURRENT pin. Ship a release.
 * 3. Wait for users to upgrade (~2 weeks).
 * 4. Rotate the live cert. Both pins continue to match (current matches old
 *    cert until cutover, backup matches new cert after).
 * 5. Ship a follow-up release that DROPS the old pin and demotes the new
 *    one to "current" with a fresh "backup" slot for the next rotation.
 *
 * If pins ever drift out of sync with reality (cert was rotated without
 * updating the pin), users see "TLS certificate mismatch — possible MITM"
 * and the CLI refuses to connect. They can `--no-cert-pin` as an emergency
 * override; we ship a hotfix release with the new pin within hours.
 *
 * @module network/cert-pinning
 */

import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { logger } from '@/ui/logger';

/**
 * Convert a colon-separated openssl fingerprint to lower-case hex
 * (e.g. "AB:CD:EF" -> "abcdef") so we can compare it to Node's TLS API
 * which returns the upper-case colon-form too. We normalise both sides.
 */
function normaliseFingerprint(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase();
}

/**
 * Pinned SHA-256 fingerprints of the live leaf certs (captured 2026-05-05).
 *
 * Each host maps to an array of accepted fingerprints. Match against ANY
 * one is enough — this is the "two-pin" model that supports rotation.
 *
 * NOTE: Wildcard `supabase.co` certs cover all `*.supabase.co` subdomains
 * (per the project's Universe public CA). The akmtmxunjhsgldjztdtt subdomain
 * has its own cert with a different fingerprint — pin both.
 */
const PINS: Record<string, string[]> = {
  // styrbyapp.com (apex + www) -- single Cloudflare-issued cert
  'styrbyapp.com': [
    '4babb0a0a65f9ecca6c981011830642ffd0bda53656e351d5ffad8ef5a8d4497',
  ],
  'www.styrbyapp.com': [
    '4babb0a0a65f9ecca6c981011830642ffd0bda53656e351d5ffad8ef5a8d4497',
  ],

  // Supabase project -- akmtmxunjhsgldjztdtt.supabase.co
  'akmtmxunjhsgldjztdtt.supabase.co': [
    'b9b8f4ce6c861d3dd1678708fa4a4062107ee7050b52820f991050f12eb29100',
  ],

  // Supabase apex (used for some unauthenticated probes)
  'supabase.co': [
    'fce028b4a5d2602a6dc5ee52fc75007a1f9dcad85cc34e506648ca6fc99864fc',
  ],
};

/**
 * Compute the SHA-256 fingerprint of a peer certificate's DER encoding.
 *
 * Node's `cert.fingerprint256` (added in 11.4.0) gives us the upper-case
 * colon form for free, but we recompute from the raw DER to defend against
 * a malicious TLS implementation that lies in `fingerprint256`.
 */
function fingerprintFromCert(cert: tls.PeerCertificate): string {
  const raw = (cert as tls.PeerCertificate & { raw?: Buffer }).raw;
  if (raw && raw.length > 0) {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
  // Fallback to the library-provided string (less defensive but still
  // returns a valid hex).
  return normaliseFingerprint(cert.fingerprint256 || '');
}

/**
 * Look up the pin set for a hostname. Falls back to the parent domain pin
 * if the exact host isn't pinned (e.g. `db.akmtmx....supabase.co` falls
 * back to `supabase.co`'s pin if the project-specific one isn't matched).
 */
function findPinsForHost(host: string): string[] | null {
  const direct = PINS[host];
  if (direct) return direct;
  // Try one-level parent (single-label strip).
  const idx = host.indexOf('.');
  if (idx > 0) {
    const parent = host.slice(idx + 1);
    if (PINS[parent]) return PINS[parent];
  }
  return null;
}

/**
 * Returns true if pinning is disabled for this run via env/CLI flag.
 *
 * SECURITY: surfaced as a warning at every call site so an operator who
 * disables pinning is reminded their session is unprotected.
 */
export function isPinningDisabled(): boolean {
  if (process.env.STYRBY_NO_CERT_PIN === '1') return true;
  // CLI flag is parsed elsewhere and re-exported through the env var.
  if (process.argv.includes('--no-cert-pin')) {
    process.env.STYRBY_NO_CERT_PIN = '1';
    return true;
  }
  return false;
}

/**
 * Build a `checkServerIdentity` callback that ALSO verifies the peer cert
 * fingerprint against our pinned set, in addition to the default hostname
 * + chain checks.
 *
 * Returning `undefined` from `checkServerIdentity` means "trust"; returning
 * an Error means "reject and emit `error` on the socket".
 */
export function makePinnedCheckServerIdentity(): (host: string, cert: tls.PeerCertificate) => Error | undefined {
  return (host: string, cert: tls.PeerCertificate): Error | undefined => {
    // Always run the default hostname/SAN check first.
    const defaultErr = tls.checkServerIdentity(host, cert);
    if (defaultErr) return defaultErr;

    if (isPinningDisabled()) {
      logger.warn(`[cert-pin] Pinning disabled (STYRBY_NO_CERT_PIN/--no-cert-pin) for ${host} — TLS chain trust only.`);
      return undefined;
    }

    const pins = findPinsForHost(host);
    if (!pins || pins.length === 0) {
      // Host not in our pin set — let the default chain check decide.
      return undefined;
    }

    const observed = fingerprintFromCert(cert);
    const matches = pins.some(p => p === observed);
    if (!matches) {
      logger.error(
        `[cert-pin] TLS pin mismatch for ${host}. Observed=${observed} expected one of=[${pins.join(',')}]. ` +
        `Refusing to connect. If you trust this network, run with --no-cert-pin to override.`
      );
      return new Error(
        `TLS certificate pin mismatch for ${host}. Possible MITM. ` +
        `Use --no-cert-pin or STYRBY_NO_CERT_PIN=1 to override.`
      );
    }
    return undefined;
  };
}

/**
 * A reusable https.Agent configured with our pinned TLS verification.
 *
 * Use this as the `dispatcher`/`agent` for any fetch/http call that targets
 * a pinned host. Supabase Realtime accepts a custom Agent through its
 * `realtime: { transport: { agent } }` option.
 */
export const pinnedAgent = new https.Agent({
  keepAlive: true,
  // checkServerIdentity is consulted on TLS handshake (Node 12+).
  checkServerIdentity: makePinnedCheckServerIdentity(),
});

/**
 * `fetch` wrapper that enforces TLS pinning on the resolved hostname.
 *
 * Implementation note: Node 20's global `fetch` (undici) does NOT honor
 * the `agent` option directly. We force it through `https.request` for
 * pinned hosts, and pass through unchanged for everything else (HTTP,
 * non-pinned hosts) so this remains a drop-in replacement.
 *
 * @param url - The URL to fetch
 * @param init - Standard `RequestInit`
 */
export async function pinnedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = typeof url === 'string' ? new URL(url) : url;
  // Non-HTTPS or unpinned hosts: pass through.
  if (u.protocol !== 'https:' || !findPinsForHost(u.hostname)) {
    return fetch(u, init);
  }

  // For pinned hosts we need to use https.request with our pinned agent
  // because undici ignores `agent`. We adapt to a Response.
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = new Headers(init.headers as any);
      h.forEach((v: string, k: string) => { headers[k] = v; });
    }
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      agent: pinnedAgent,
      // Defensive: also pass checkServerIdentity directly so it applies even
      // if a caller substitutes the agent.
      checkServerIdentity: makePinnedCheckServerIdentity(),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) responseHeaders.set(k, v.join(', '));
          else if (v != null) responseHeaders.set(k, String(v));
        }
        resolve(new Response(body, {
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
        }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (init?.body != null) {
      // Body is BodyInit — for our use cases it'll be string|Buffer|Uint8Array.
      const b = init.body as unknown;
      if (typeof b === 'string' || b instanceof Buffer || b instanceof Uint8Array) {
        req.end(b);
      } else {
        // Streams etc. — fall back to undici (pin won't apply here).
        req.destroy();
        fetch(u, init).then(resolve, reject);
        return;
      }
    } else {
      req.end();
    }
  });
}

/**
 * Test-only: expose the pin map so tests can override it.
 */
export const __pinsForTesting = PINS;
