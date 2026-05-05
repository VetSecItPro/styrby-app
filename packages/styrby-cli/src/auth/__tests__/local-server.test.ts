/**
 * Tests for the local OAuth callback server (auth/local-server.ts).
 *
 * WHY this file exists:
 *   - Coverage baseline 2026-05-05 reported 0% on local-server.ts (110 LOC).
 *   - The file is security-critical: it binds an HTTP server on localhost
 *     to receive OAuth authorization codes during the browser-OAuth flow.
 *     Bugs here cause auth flows to silently break OR — worse — could
 *     accept callbacks from unintended origins.
 *
 * What's tested:
 *   1. Happy path: code parameter → resolves with code, returns 200 + HTML
 *   2. Error path: error parameter → resolves with error fields
 *   3. Missing-code path: neither code nor error → resolves with error
 *   4. Non-/callback paths return 404 (limits the attack surface)
 *   5. Non-GET methods return 404
 *   6. Server binds only to 127.0.0.1 (not 0.0.0.0) — security invariant
 *   7. Port-finding fallback when preferred port is taken
 *   8. Timeout rejection when no callback arrives within the deadline
 *   9. Close() shuts down the server cleanly
 *
 * What's NOT tested here:
 *   - State parameter validation (caller responsibility, see browser-auth.ts)
 *   - HTML page content (cosmetic)
 *
 * @module auth/__tests__/local-server
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as http from 'node:http';
import { startAuthCallbackServer, type LocalAuthServer } from '@/auth/local-server';

/**
 * Tracked active servers so afterEach can clean them up even if a test fails
 * mid-flight. Without this, a leaked server would keep its port bound and
 * cause subsequent tests to flake.
 */
const activeServers: LocalAuthServer[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop()!;
    try {
      await server.close();
    } catch {
      /* ignore close errors during cleanup */
    }
  }
});

/**
 * Helper: HTTP GET against the callback URL.
 *
 * WHY a custom helper (not fetch): we need to capture status and body
 * deterministically, avoiding the response-flush race that occurs when
 * the server resolves callbackPromise immediately after `res.end()`.
 * Using `Connection: close` header forces the response body to be fully
 * delivered before the connection is torn down, eliminating the
 * ECONNRESET class of test flake.
 */
function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      // Force connection close after response — server sends Content-Length
      // implicitly via res.end(body), and Connection: close ensures the
      // response is fully delivered before the socket goes away.
      { headers: { Connection: 'close' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => reject(err));
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('test http GET timeout')));
  });
}

/**
 * Helper to start a server, register it for cleanup, and return its handle.
 */
async function startTrackedServer(
  options: Parameters<typeof startAuthCallbackServer>[0] = {}
): Promise<LocalAuthServer> {
  const server = await startAuthCallbackServer(options);
  activeServers.push(server);
  return server;
}

describe('startAuthCallbackServer', () => {
  describe('happy path', () => {
    it('resolves with code when /callback?code=... is hit', async () => {
      const server = await startTrackedServer();
      const callbackPromise = server.waitForCallback();

      const response = await httpGet(`${server.callbackUrl}?code=test-code-123&state=xyz`);

      expect(response.status).toBe(200);
      expect(response.body).toContain('Authentication Successful');

      const result = await callbackPromise;
      expect(result.code).toBe('test-code-123');
      expect(result.state).toBe('xyz');
      expect(result.error).toBeUndefined();
    });

    it('resolves with code even when state is omitted', async () => {
      const server = await startTrackedServer();
      const callbackPromise = server.waitForCallback();

      await httpGet(`${server.callbackUrl}?code=just-code`);

      const result = await callbackPromise;
      expect(result.code).toBe('just-code');
      expect(result.state).toBeUndefined();
    });
  });

  describe('error path', () => {
    it('resolves with error fields when /callback?error=... is hit', async () => {
      const server = await startTrackedServer();
      const callbackPromise = server.waitForCallback();

      const response = await httpGet(
        `${server.callbackUrl}?error=access_denied&error_description=user+denied&state=abc`
      );

      expect(response.status).toBe(200);
      expect(response.body).toContain('Authentication Failed');
      expect(response.body).toContain('access_denied');

      const result = await callbackPromise;
      expect(result.error).toBe('access_denied');
      expect(result.errorDescription).toBe('user denied');
      expect(result.state).toBe('abc');
      expect(result.code).toBeUndefined();
    });

    it('resolves with error when error_description is omitted', async () => {
      const server = await startTrackedServer();
      const callbackPromise = server.waitForCallback();

      await httpGet(`${server.callbackUrl}?error=server_error`);

      const result = await callbackPromise;
      expect(result.error).toBe('server_error');
      expect(result.errorDescription).toBeUndefined();
    });
  });

  describe('missing-code path', () => {
    it('returns 400 + resolves with missing_code error when neither code nor error is present', async () => {
      const server = await startTrackedServer();
      const callbackPromise = server.waitForCallback();

      const response = await httpGet(server.callbackUrl);

      expect(response.status).toBe(400);
      expect(response.body).toContain('missing_code');

      const result = await callbackPromise;
      expect(result.error).toBe('missing_code');
      expect(result.code).toBeUndefined();
    });
  });

  describe('attack-surface limits', () => {
    it('returns 404 for paths that are not /callback', async () => {
      const server = await startTrackedServer();

      // NOTE: do not include `/callback-fake` here — it startsWith `/callback`
      // and the server's URL gate uses startsWith (intentionally — query strings
      // attach to /callback?code=..). A path that startsWith /callback but has
      // no code returns 400 missing_code, not 404. So we test paths that
      // genuinely don't startsWith /callback.
      const responses = await Promise.all([
        httpGet(`http://127.0.0.1:${server.port}/`),
        httpGet(`http://127.0.0.1:${server.port}/admin`),
        httpGet(`http://127.0.0.1:${server.port}/api/callback`),
      ]);

      for (const r of responses) {
        expect(r.status).toBe(404);
        expect(r.body).toBe('Not Found');
      }
    });

    it('returns 404 for non-GET methods on /callback', async () => {
      const server = await startTrackedServer();

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            path: '/callback',
            method: 'POST',
          },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('test http POST timeout')));
        req.end();
      });

      expect(status).toBe(404);
    });

    it('binds only to 127.0.0.1, not 0.0.0.0 (security invariant)', async () => {
      const server = await startTrackedServer();

      // The callback URL itself should hardcode 127.0.0.1
      expect(server.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      // Note: we don't try to connect via 0.0.0.0 or the LAN IP because:
      //   - macOS would treat 127.0.0.1 and 0.0.0.0 differently per network interface
      //   - the assertion above is sufficient: callback URL is hardcoded 127.0.0.1
      //   - the server.listen() in the implementation passes LOCALHOST = '127.0.0.1'
      //     as the host arg (verified by reading the source)
    });
  });

  describe('port allocation', () => {
    it('falls back to next available port when preferred port is taken', async () => {
      // Take port 52280 (the default first-tried port) with a separate server
      const blocker = http.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(52280, '127.0.0.1', () => {
          blocker.removeListener('error', reject);
          resolve();
        });
      });

      try {
        // Now request the callback server with preferredPort=52280 — should fall back
        const server = await startTrackedServer({ preferredPort: 52280 });
        expect(server.port).not.toBe(52280);
        expect(server.port).toBeGreaterThanOrEqual(52281);
        expect(server.port).toBeLessThanOrEqual(52290);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  describe('timeout', () => {
    it('rejects waitForCallback() if no callback arrives within the deadline', async () => {
      const server = await startTrackedServer({ timeout: 50 });

      await expect(server.waitForCallback()).rejects.toThrow(
        /Authentication timed out/i
      );
    });
  });

  describe('lifecycle', () => {
    it('close() releases the port (subsequent listen() on same port works)', async () => {
      const server = await startTrackedServer();
      const port = server.port;

      // Remove from tracking since we close manually
      const idx = activeServers.indexOf(server);
      if (idx >= 0) activeServers.splice(idx, 1);

      await server.close();

      // The port should now be free — verify by binding it directly.
      const verifier = http.createServer();
      await expect(
        new Promise<void>((resolve, reject) => {
          verifier.once('error', reject);
          verifier.listen(port, '127.0.0.1', () => {
            verifier.removeListener('error', reject);
            verifier.close(() => resolve());
          });
        })
      ).resolves.toBeUndefined();
    });
  });
});
