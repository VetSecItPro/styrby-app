/**
 * Loading state for the session detail page.
 *
 * Shows a skeleton layout matching the actual page structure
 * while session data is being fetched.
 */

export default function SessionLoading() {
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-zinc-950 animate-pulse">
      {/* Header skeleton */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="h-5 w-5 rounded bg-zinc-800" />
          <div className="flex-1">
            <div className="h-6 w-48 rounded bg-zinc-800 mb-2" />
            <div className="flex items-center gap-3">
              <div className="h-5 w-16 rounded-full bg-zinc-800" />
              <div className="h-5 w-20 rounded bg-zinc-800" />
              <div className="h-5 w-24 rounded bg-zinc-800" />
            </div>
          </div>
        </div>
      </header>

      {/* Chat area skeleton */}
      <div className="flex-1 p-6 space-y-4">
        {/* User message skeleton */}
        <div className="ml-auto max-w-[70%]">
          <div className="h-4 w-12 rounded bg-zinc-800 mb-2" />
          <div className="h-20 rounded-lg bg-blue-600/20" />
        </div>

        {/* Agent message skeleton */}
        <div className="max-w-[80%]">
          <div className="h-4 w-12 rounded bg-zinc-800 mb-2" />
          <div className="h-32 rounded-lg bg-zinc-800" />
        </div>

        {/* Permission card skeleton */}
        <div className="max-w-[80%]">
          <div className="h-40 rounded-lg border-2 border-yellow-500/50 bg-yellow-500/5" />
        </div>

        {/* Another agent message skeleton */}
        <div className="max-w-[80%]">
          <div className="h-4 w-12 rounded bg-zinc-800 mb-2" />
          <div className="h-24 rounded-lg bg-zinc-800" />
        </div>
      </div>

      {/* Input skeleton */}
      <div className="border-t border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex gap-3">
          <div className="flex-1 h-12 rounded-lg bg-zinc-800" />
          <div className="h-12 w-12 rounded-lg bg-zinc-800" />
        </div>
        <div className="mt-2 h-3 w-48 rounded bg-zinc-800" />
      </div>
    </div>
  );
}
