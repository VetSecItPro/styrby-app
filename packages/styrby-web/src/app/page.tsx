import Link from 'next/link';

/**
 * Landing page - redirect to dashboard if authenticated, show marketing otherwise.
 * For MVP, we'll keep it simple with a direct link to login.
 */
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        {/* Logo placeholder */}
        <div className="mb-8 flex justify-center">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
            <span className="text-3xl font-bold text-white">S</span>
          </div>
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          <span className="text-orange-500">Styrby</span>
        </h1>

        <p className="mt-4 text-xl text-zinc-400">
          Mobile Remote for AI Coding Agents
        </p>

        <p className="mt-6 text-lg text-zinc-500 max-w-lg mx-auto">
          Control Claude Code, Codex, and Gemini CLI from your phone.
          Track costs, approve permissions, manage sessions — all from your pocket.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/login"
            className="rounded-lg bg-orange-500 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 transition-colors"
          >
            Get Started
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg bg-zinc-800 px-6 py-3 text-base font-semibold text-zinc-100 shadow-sm hover:bg-zinc-700 transition-colors"
          >
            Dashboard
          </Link>
        </div>

        {/* Feature highlights */}
        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-8 text-left">
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800">
            <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center mb-3">
              <span className="text-orange-500">💰</span>
            </div>
            <h3 className="font-semibold text-zinc-100">Cost Tracking</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Real-time token usage and spend across all agents
            </p>
          </div>

          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800">
            <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center mb-3">
              <span className="text-green-500">🔐</span>
            </div>
            <h3 className="font-semibold text-zinc-100">Permission Control</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Approve or deny agent actions from anywhere
            </p>
          </div>

          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800">
            <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center mb-3">
              <span className="text-blue-500">🤖</span>
            </div>
            <h3 className="font-semibold text-zinc-100">Multi-Agent</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Claude, Codex, and Gemini in one dashboard
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
