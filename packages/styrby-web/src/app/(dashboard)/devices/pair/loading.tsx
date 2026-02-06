/**
 * Loading state for the device pairing page.
 *
 * Shows a skeleton layout matching the actual page structure
 * while data is being fetched.
 */

export default function PairingLoading() {
  return (
    <div className="min-h-screen bg-zinc-950 animate-pulse">
      {/* Header skeleton */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="h-8 w-24 rounded bg-zinc-800" />
            <div className="flex items-center gap-6">
              <div className="h-4 w-20 rounded bg-zinc-800" />
              <div className="h-4 w-20 rounded bg-zinc-800" />
              <div className="h-4 w-20 rounded bg-zinc-800" />
            </div>
            <div className="h-4 w-32 rounded bg-zinc-800" />
          </div>
        </div>
      </header>

      {/* Main content skeleton */}
      <main className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-12">
        {/* Back link skeleton */}
        <div className="h-4 w-32 rounded bg-zinc-800 mb-8" />

        {/* Title skeleton */}
        <div className="h-8 w-48 rounded bg-zinc-800 mb-2" />
        <div className="h-4 w-96 rounded bg-zinc-800 mb-8" />

        {/* QR code skeleton */}
        <div className="flex flex-col items-center">
          <div className="h-64 w-64 rounded-lg bg-zinc-800" />
          <div className="mt-4 flex items-center gap-2">
            <div className="h-4 w-4 rounded-full bg-zinc-800" />
            <div className="h-4 w-32 rounded bg-zinc-800" />
          </div>
        </div>

        {/* Instructions skeleton */}
        <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="h-6 w-32 rounded bg-zinc-800 mb-4" />
          <div className="space-y-3">
            <div className="h-4 w-full rounded bg-zinc-800" />
            <div className="h-4 w-3/4 rounded bg-zinc-800" />
            <div className="h-4 w-5/6 rounded bg-zinc-800" />
            <div className="h-4 w-2/3 rounded bg-zinc-800" />
          </div>
        </div>

        {/* Paired devices skeleton */}
        <div className="mt-12">
          <div className="h-6 w-40 rounded bg-zinc-800 mb-4" />
          <div className="space-y-3">
            <div className="h-20 rounded-lg border border-zinc-800 bg-zinc-900/50" />
            <div className="h-20 rounded-lg border border-zinc-800 bg-zinc-900/50" />
          </div>
        </div>
      </main>
    </div>
  );
}
