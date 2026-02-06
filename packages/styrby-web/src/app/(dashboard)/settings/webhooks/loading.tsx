/**
 * Loading state for the Webhooks settings page.
 *
 * Shows skeleton placeholders matching the layout of the actual page
 * while data is being fetched from Supabase.
 */

export default function WebhooksLoading() {
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
            <nav className="flex items-center gap-6">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-4 w-16 rounded bg-zinc-800 animate-pulse" />
              ))}
            </nav>
            <div className="h-4 w-32 rounded bg-zinc-800 animate-pulse" />
          </div>
        </div>
      </header>

      {/* Main content skeleton */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-3 mb-2">
          <div className="h-4 w-16 rounded bg-zinc-800 animate-pulse" />
          <div className="h-4 w-2 rounded bg-zinc-800 animate-pulse" />
          <div className="h-4 w-20 rounded bg-zinc-800 animate-pulse" />
        </div>

        {/* Title */}
        <div className="h-8 w-32 rounded bg-zinc-800 animate-pulse mb-8" />

        {/* Controls */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="h-4 w-40 rounded bg-zinc-800 animate-pulse" />
            <div className="h-4 w-32 rounded bg-zinc-800 animate-pulse" />
          </div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-32 rounded-lg bg-zinc-800 animate-pulse" />
            <div className="h-10 w-36 rounded-lg bg-zinc-800 animate-pulse" />
          </div>
        </div>

        {/* Webhook cards skeleton */}
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="rounded-xl bg-zinc-900 border border-zinc-800 p-4"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="h-5 w-40 rounded bg-zinc-800 animate-pulse mb-2" />
                  <div className="h-3 w-64 rounded bg-zinc-800 animate-pulse" />
                </div>
                <div className="h-5 w-9 rounded-full bg-zinc-800 animate-pulse" />
              </div>
              <div className="flex gap-2 mb-3">
                {[...Array(3)].map((_, j) => (
                  <div key={j} className="h-5 w-24 rounded-full bg-zinc-800 animate-pulse" />
                ))}
              </div>
              <div className="flex items-center justify-between">
                <div className="h-3 w-32 rounded bg-zinc-800 animate-pulse" />
                <div className="flex gap-1">
                  {[...Array(4)].map((_, j) => (
                    <div key={j} className="h-7 w-7 rounded-lg bg-zinc-800 animate-pulse" />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
