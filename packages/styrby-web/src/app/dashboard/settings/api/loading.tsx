/**
 * Loading state for API Keys page.
 */

export default function Loading() {
  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header skeleton */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="h-8 w-8 rounded-lg bg-zinc-800 animate-pulse" />
              <div className="h-4 w-16 rounded bg-zinc-800 animate-pulse" />
            </div>
            <div className="flex items-center gap-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-4 w-16 rounded bg-zinc-800 animate-pulse" />
              ))}
            </div>
            <div className="h-4 w-32 rounded bg-zinc-800 animate-pulse" />
          </div>
        </div>
      </header>

      {/* Content skeleton */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-4 w-16 rounded bg-zinc-800 animate-pulse" />
          <div className="h-4 w-4 rounded bg-zinc-800 animate-pulse" />
          <div className="h-4 w-20 rounded bg-zinc-800 animate-pulse" />
        </div>
        <div className="h-8 w-32 rounded bg-zinc-800 animate-pulse mb-8" />

        {/* Controls skeleton */}
        <div className="flex items-center justify-between mb-6">
          <div className="h-4 w-48 rounded bg-zinc-800 animate-pulse" />
          <div className="flex items-center gap-3">
            <div className="h-10 w-28 rounded-lg bg-zinc-800 animate-pulse" />
            <div className="h-10 w-32 rounded-lg bg-zinc-800 animate-pulse" />
          </div>
        </div>

        {/* Key cards skeleton */}
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl bg-zinc-900 border border-zinc-800 p-4"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="h-5 w-32 rounded bg-zinc-800 animate-pulse mb-2" />
                  <div className="h-3 w-48 rounded bg-zinc-800 animate-pulse" />
                </div>
                <div className="h-8 w-16 rounded-lg bg-zinc-800 animate-pulse" />
              </div>
              <div className="flex gap-2 mb-3">
                <div className="h-5 w-12 rounded-full bg-zinc-800 animate-pulse" />
              </div>
              <div className="flex gap-6">
                <div className="h-3 w-24 rounded bg-zinc-800 animate-pulse" />
                <div className="h-3 w-32 rounded bg-zinc-800 animate-pulse" />
                <div className="h-3 w-20 rounded bg-zinc-800 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
