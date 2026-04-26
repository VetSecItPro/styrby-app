import type { Metadata } from 'next';
import { WifiOff } from 'lucide-react';
import { RefreshButton } from './refresh-button';

export const metadata: Metadata = {
  title: 'Offline',
  description: 'You are currently offline. Reconnect to continue using Styrby.',
};

/**
 * Offline fallback page served by the service worker when the user navigates
 * to a page while disconnected from the network.
 *
 * WHY: Without an offline fallback, the browser shows a generic "No Internet"
 * error page. This branded page reassures users that the app is still
 * installed, their data is safe, and they can return when connectivity is
 * restored. It is precached by the service worker so it loads instantly
 * even without network access.
 *
 * The page intentionally avoids client-side JavaScript, dynamic imports,
 * and external resources so it can be precached as a single static HTML
 * document with zero runtime dependencies.
 *
 * @returns The offline fallback page component
 */
export default function OfflinePage() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center"
    >
      <div className="mx-auto max-w-md space-y-6">
        <div className="flex justify-center">
          <div className="rounded-full bg-muted p-4">
            <WifiOff className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
          </div>
        </div>

        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          You are offline.
        </h1>

        <p className="text-lg text-muted-foreground">
          Connection dropped. Anything you did while online is already saved on the server. Approvals and commands you tap from here queue locally and sync the moment the network comes back.
        </p>

        <div className="flex flex-col gap-3 pt-2">
          <a
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Back to my dashboard
          </a>
          <RefreshButton />
        </div>

        <p className="text-xs text-muted-foreground/60">
          Queued actions sync automatically the moment you reconnect.
        </p>
      </div>
    </main>
  );
}
