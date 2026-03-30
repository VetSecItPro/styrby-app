/**
 * Next.js Instrumentation Hook
 *
 * This file is the official Next.js entry point for third-party observability
 * tools. It is loaded once per server process start (not per request).
 *
 * WHY we use this instead of importing Sentry in layout.tsx or middleware:
 * - This hook runs before any user code, ensuring Sentry captures errors
 *   that occur during module initialization and server startup.
 * - It is the recommended approach by both Next.js and Sentry for App Router.
 * - It correctly separates Node.js and edge runtime initialization, which
 *   require different Sentry SDK builds.
 *
 * WHY the runtime check:
 * Next.js can run in two server environments:
 * - 'nodejs': Full Node.js (API routes, Server Components, Server Actions)
 * - 'edge': Restricted V8 isolate (middleware, Edge API Routes)
 * Each needs a different Sentry initialization file with the appropriate SDK build.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 * @see https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    /**
     * Load the Node.js Sentry config for server-side error capture.
     * Handles: Server Components, Route Handlers, Server Actions.
     */
    await import('../sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    /**
     * Load the edge-compatible Sentry config for middleware error capture.
     * Handles: Next.js middleware running on the Vercel Edge Network.
     */
    await import('../sentry.edge.config');
  }
}
