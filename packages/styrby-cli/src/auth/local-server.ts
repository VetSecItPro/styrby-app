/**
 * Local OAuth Callback Server
 *
 * Creates a temporary HTTP server on localhost to receive OAuth callbacks.
 * Handles the authorization code redirect from Supabase Auth.
 *
 * WHY: OAuth flows require a redirect URI. We run a local server briefly
 * to capture the authorization code, then shut it down immediately.
 * This is similar to how Claude Code's /login flow works.
 *
 * @module auth/local-server
 */

import * as http from 'node:http';
import { logger } from '@/ui/logger';

// ============================================================================
// Constants
// ============================================================================

/**
 * Port range for callback server (like Claude Code uses 52280-52290)
 */
const MIN_PORT = 52280;
const MAX_PORT = 52290;

/**
 * Localhost address (IPv4 only for security)
 */
const LOCALHOST = '127.0.0.1';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for starting the callback server
 */
export interface CallbackServerOptions {
  /** Timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number;
  /** Preferred port (will try alternatives if taken) */
  preferredPort?: number;
}

/**
 * Result from OAuth callback
 */
export interface AuthCallbackResult {
  /** Authorization code (if successful) */
  code?: string;
  /** State parameter (for CSRF validation) */
  state?: string;
  /** Error code (if failed) */
  error?: string;
  /** Error description (if failed) */
  errorDescription?: string;
}

/**
 * Local auth server handle
 */
export interface LocalAuthServer {
  /** Server port */
  port: number;
  /** Full callback URL */
  callbackUrl: string;
  /** Wait for callback (returns result or throws on timeout) */
  waitForCallback: () => Promise<AuthCallbackResult>;
  /** Close the server */
  close: () => Promise<void>;
}

// ============================================================================
// Success HTML Page
// ============================================================================

/**
 * HTML page shown after successful authentication
 */
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Styrby - Authentication Successful</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .logo {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    p {
      color: #a0a0a0;
      margin-bottom: 1.5rem;
    }
    .checkmark {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #22c55e;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .checkmark svg {
      width: 40px;
      height: 40px;
      stroke: white;
      stroke-width: 3;
    }
    .hint {
      font-size: 0.875rem;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1>Authentication Successful!</h1>
    <p>You can close this window and return to the terminal.</p>
    <p class="hint">This window will close automatically...</p>
  </div>
  <script>
    setTimeout(function() { window.close(); }, 3000);
  </script>
</body>
</html>`;

/**
 * HTML page shown after authentication error
 */
const ERROR_HTML = (error: string, description: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Styrby - Authentication Failed</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    .error-icon {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #ef4444;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .error-icon svg {
      width: 40px;
      height: 40px;
      stroke: white;
      stroke-width: 3;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .error-details {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
      text-align: left;
    }
    .error-details code {
      display: block;
      font-size: 0.875rem;
      color: #f87171;
    }
    p {
      color: #a0a0a0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </div>
    <h1>Authentication Failed</h1>
    <div class="error-details">
      <code>${error}: ${description}</code>
    </div>
    <p>Please return to the terminal and try again.</p>
  </div>
</body>
</html>`;

// ============================================================================
// Port Finding
// ============================================================================

/**
 * Find an available port in the specified range.
 *
 * @param preferredPort - Preferred port to try first
 * @returns Available port number
 * @throws Error if no ports are available
 */
async function findAvailablePort(preferredPort?: number): Promise<number> {
  const startPort = preferredPort ?? MIN_PORT;

  for (let port = startPort; port <= MAX_PORT; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  // If preferred port was specified and failed, try the full range
  if (preferredPort && preferredPort !== MIN_PORT) {
    for (let port = MIN_PORT; port <= MAX_PORT; port++) {
      if (await isPortAvailable(port)) {
        return port;
      }
    }
  }

  throw new Error(
    `No available ports in range ${MIN_PORT}-${MAX_PORT}. ` +
      'Close other applications using these ports and try again.'
  );
}

/**
 * Check if a port is available.
 *
 * @param port - Port to check
 * @returns True if port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, LOCALHOST);
  });
}

// ============================================================================
// Callback Server
// ============================================================================

/**
 * Start a local HTTP server to receive OAuth callbacks.
 *
 * The server listens on localhost only (127.0.0.1) for security.
 * It automatically finds an available port in the 52280-52290 range.
 *
 * @param options - Server options
 * @returns Server handle with waitForCallback and close methods
 *
 * @example
 * const server = await startAuthCallbackServer();
 * console.log('Redirect to:', server.callbackUrl);
 * const result = await server.waitForCallback();
 * await server.close();
 */
export async function startAuthCallbackServer(
  options: CallbackServerOptions = {}
): Promise<LocalAuthServer> {
  const { timeout = 120000, preferredPort } = options;

  const port = await findAvailablePort(preferredPort);
  const callbackUrl = `http://${LOCALHOST}:${port}/callback`;

  let resolveCallback: (result: AuthCallbackResult) => void;
  let rejectCallback: (error: Error) => void;

  const callbackPromise = new Promise<AuthCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  // Set up timeout
  const timeoutId = setTimeout(() => {
    rejectCallback(new Error('Authentication timed out. Please try again.'));
  }, timeout);

  // Create HTTP server
  const server = http.createServer((req, res) => {
    // Only handle GET requests to /callback
    if (req.method !== 'GET' || !req.url?.startsWith('/callback')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Parse query parameters
    const url = new URL(req.url, `http://${LOCALHOST}:${port}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Clear timeout since we got a response
    clearTimeout(timeoutId);

    if (error) {
      // Send error page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML(error, errorDescription || 'Unknown error'));

      logger.debug('Auth callback received error', { error, errorDescription });

      resolveCallback({
        error,
        errorDescription: errorDescription || undefined,
        state: state || undefined,
      });
    } else if (code) {
      // Send success page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);

      logger.debug('Auth callback received code');

      resolveCallback({
        code,
        state: state || undefined,
      });
    } else {
      // No code or error - unexpected response
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML('missing_code', 'No authorization code received'));

      resolveCallback({
        error: 'missing_code',
        errorDescription: 'No authorization code received',
        state: state || undefined,
      });
    }
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOCALHOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.debug('Auth callback server started', { port, callbackUrl });

  return {
    port,
    callbackUrl,
    waitForCallback: () => callbackPromise,
    close: async () => {
      clearTimeout(timeoutId);
      return new Promise((resolve) => {
        server.close(() => {
          logger.debug('Auth callback server closed');
          resolve();
        });
      });
    },
  };
}

/**
 * Default export for module
 */
export default {
  startAuthCallbackServer,
};
