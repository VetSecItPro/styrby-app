import Link from 'next/link';

/**
 * Custom 404 page.
 *
 * WHY: The default Next.js 404 page is unbranded and confusing. A branded
 * page maintains the Styrby dark theme and provides clear navigation options
 * to help users recover from mistyped URLs or broken links.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        <div className="mx-auto h-16 w-16 rounded-full bg-orange-500/10 flex items-center justify-center mb-6">
          <span className="text-2xl font-bold text-orange-400">404</span>
        </div>

        <h1 className="text-2xl font-bold text-zinc-100 mb-2">
          Page Not Found
        </h1>
        <p className="text-zinc-400 mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/dashboard"
            className="rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            Go to Dashboard
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-6 py-2.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700 transition-colors"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
