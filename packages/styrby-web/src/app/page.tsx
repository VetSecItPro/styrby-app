import Link from 'next/link';

/**
 * Marketing landing page - showcases Styrby features and benefits.
 */
export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Navigation */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                <span className="text-lg font-bold text-white">S</span>
              </div>
              <span className="font-semibold text-zinc-100">Styrby</span>
            </div>

            <nav className="hidden md:flex items-center gap-8">
              <a href="#features" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">
                Features
              </a>
              <a href="#how-it-works" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">
                How It Works
              </a>
              <a href="#pricing" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">
                Pricing
              </a>
            </nav>

            <div className="flex items-center gap-4">
              <Link
                href="/login"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sign In
              </Link>
              <Link
                href="/login"
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              >
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-orange-500/5 via-transparent to-transparent" />
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-96 h-96 bg-orange-500/20 rounded-full blur-3xl" />

        <div className="relative mx-auto max-w-4xl text-center">
          {/* Logo */}
          <div className="mb-8 flex justify-center">
            <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
              <span className="text-4xl font-bold text-white">S</span>
            </div>
          </div>

          {/* Badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-orange-500/10 px-4 py-1.5 text-sm text-orange-400 border border-orange-500/20">
            <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
            Now supporting Claude, Codex, and Gemini
          </div>

          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold tracking-tight">
            <span className="text-zinc-100">Your AI Agents,</span>
            <br />
            <span className="bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent">
              In Your Pocket
            </span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-zinc-400 max-w-2xl mx-auto">
            Control your AI coding agents from anywhere. Track costs, approve permissions,
            manage sessions — all from your phone while your agents work.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/login"
              className="rounded-xl bg-orange-500 px-8 py-4 text-base font-semibold text-white shadow-lg shadow-orange-500/20 hover:bg-orange-600 hover:shadow-orange-500/30 transition-all"
            >
              Start Free Trial
            </Link>
            <a
              href="#how-it-works"
              className="rounded-xl bg-zinc-800 px-8 py-4 text-base font-semibold text-zinc-100 hover:bg-zinc-700 transition-colors"
            >
              See How It Works
            </a>
          </div>

          {/* Agent logos */}
          <div className="mt-16 flex items-center justify-center gap-8">
            <div className="flex items-center gap-2 text-zinc-500">
              <div className="h-8 w-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                <span className="text-orange-400 font-bold">C</span>
              </div>
              <span className="text-sm">Claude Code</span>
            </div>
            <div className="flex items-center gap-2 text-zinc-500">
              <div className="h-8 w-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                <span className="text-green-400 font-bold">C</span>
              </div>
              <span className="text-sm">Codex CLI</span>
            </div>
            <div className="flex items-center gap-2 text-zinc-500">
              <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <span className="text-blue-400 font-bold">G</span>
              </div>
              <span className="text-sm">Gemini CLI</span>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100">
              Everything You Need to Stay in Control
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Monitor, manage, and control your AI agents without being chained to your desk.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Cost Tracking */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 hover:border-zinc-700 transition-colors">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-600/20 flex items-center justify-center mb-4">
                <svg className="h-6 w-6 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-zinc-100 mb-2">Real-Time Cost Tracking</h3>
              <p className="text-zinc-400">
                See exactly how much you&apos;re spending across all agents. Daily, weekly, and monthly breakdowns with model-aware pricing.
              </p>
            </div>

            {/* Permission Control */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 hover:border-zinc-700 transition-colors">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-green-500/20 to-green-600/20 flex items-center justify-center mb-4">
                <svg className="h-6 w-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-zinc-100 mb-2">Permission Control</h3>
              <p className="text-zinc-400">
                Approve or deny file writes, command execution, and API calls. Get push notifications for permission requests.
              </p>
            </div>

            {/* Multi-Agent */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 hover:border-zinc-700 transition-colors">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/20 flex items-center justify-center mb-4">
                <svg className="h-6 w-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-zinc-100 mb-2">Multi-Agent Dashboard</h3>
              <p className="text-zinc-400">
                Manage Claude, Codex, and Gemini from one unified interface. Switch between agents seamlessly.
              </p>
            </div>

            {/* Session History */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 hover:border-zinc-700 transition-colors">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/20 flex items-center justify-center mb-4">
                <svg className="h-6 w-6 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-zinc-100 mb-2">Session History</h3>
              <p className="text-zinc-400">
                Browse past sessions, search conversations, and bookmark important ones for later reference.
              </p>
            </div>

            {/* Push Notifications */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 hover:border-zinc-700 transition-colors">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-yellow-500/20 to-yellow-600/20 flex items-center justify-center mb-4">
                <svg className="h-6 w-6 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-zinc-100 mb-2">Smart Notifications</h3>
              <p className="text-zinc-400">
                Get notified when agents need attention, hit budget limits, or complete important tasks.
              </p>
            </div>

            {/* Error Attribution */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 hover:border-zinc-700 transition-colors">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-red-500/20 to-red-600/20 flex items-center justify-center mb-4">
                <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-zinc-100 mb-2">Smart Error Attribution</h3>
              <p className="text-zinc-400">
                Know instantly whether errors are from the agent, your code, build tools, or network issues.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" className="py-20 px-4 sm:px-6 lg:px-8 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100">
              Get Started in 3 Steps
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              From installation to full control in under 5 minutes.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Step 1 */}
            <div className="relative">
              <div className="absolute -top-4 -left-4 h-12 w-12 rounded-full bg-orange-500 flex items-center justify-center text-xl font-bold text-white">
                1
              </div>
              <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 pt-10">
                <h3 className="text-xl font-semibold text-zinc-100 mb-2">Install the CLI</h3>
                <p className="text-zinc-400 mb-4">
                  Install Styrby CLI on your development machine. Works with any terminal.
                </p>
                <div className="rounded-lg bg-zinc-950 p-3 font-mono text-sm text-zinc-300">
                  npm install -g styrby
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="relative">
              <div className="absolute -top-4 -left-4 h-12 w-12 rounded-full bg-orange-500 flex items-center justify-center text-xl font-bold text-white">
                2
              </div>
              <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 pt-10">
                <h3 className="text-xl font-semibold text-zinc-100 mb-2">Scan QR Code</h3>
                <p className="text-zinc-400 mb-4">
                  Run `styrby pair` in your terminal and scan the QR code with the mobile app.
                </p>
                <div className="rounded-lg bg-zinc-950 p-3 font-mono text-sm text-zinc-300">
                  styrby pair
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="relative">
              <div className="absolute -top-4 -left-4 h-12 w-12 rounded-full bg-orange-500 flex items-center justify-center text-xl font-bold text-white">
                3
              </div>
              <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 pt-10">
                <h3 className="text-xl font-semibold text-zinc-100 mb-2">Start Coding</h3>
                <p className="text-zinc-400 mb-4">
                  That&apos;s it! Your phone is now connected. Chat with agents, approve actions, track costs.
                </p>
                <div className="flex gap-2">
                  <span className="inline-flex items-center rounded-full bg-green-500/10 px-3 py-1 text-sm text-green-400">
                    Connected
                  </span>
                  <span className="inline-flex items-center rounded-full bg-orange-500/10 px-3 py-1 text-sm text-orange-400">
                    3 agents
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100">
              Simple, Transparent Pricing
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Start free, upgrade when you need more.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {/* Free */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6">
              <h3 className="text-xl font-semibold text-zinc-100">Free</h3>
              <p className="mt-2 text-sm text-zinc-500">For trying things out</p>
              <div className="mt-4">
                <span className="text-4xl font-bold text-zinc-100">$0</span>
                <span className="text-zinc-500">/month</span>
              </div>
              <ul className="mt-6 space-y-3">
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  1 connected machine
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  7-day session history
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  1,000 messages/month
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  All 3 agents supported
                </li>
              </ul>
              <Link
                href="/login"
                className="mt-8 block w-full rounded-lg bg-zinc-800 py-3 text-center text-sm font-semibold text-zinc-100 hover:bg-zinc-700 transition-colors"
              >
                Get Started
              </Link>
            </div>

            {/* Pro */}
            <div className="rounded-2xl bg-gradient-to-b from-orange-500/10 to-zinc-900 border border-orange-500/20 p-6 relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-500 px-3 py-1 text-xs font-medium text-white">
                Most Popular
              </div>
              <h3 className="text-xl font-semibold text-zinc-100">Pro</h3>
              <p className="mt-2 text-sm text-zinc-500">For daily use</p>
              <div className="mt-4">
                <span className="text-4xl font-bold text-zinc-100">$19</span>
                <span className="text-zinc-500">/month</span>
                <div className="text-sm text-green-400 mt-1">or $190/year (2 months free)</div>
              </div>
              <ul className="mt-6 space-y-3">
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  5 connected machines
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  90-day session history
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  25,000 messages/month
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Budget alerts + analytics
                </li>
              </ul>
              <Link
                href="/login"
                className="mt-8 block w-full rounded-lg bg-orange-500 py-3 text-center text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              >
                Start Free Trial
              </Link>
            </div>

            {/* Power */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6">
              <h3 className="text-xl font-semibold text-zinc-100">Power</h3>
              <p className="mt-2 text-sm text-zinc-500">For teams and power users</p>
              <div className="mt-4">
                <span className="text-4xl font-bold text-zinc-100">$49</span>
                <span className="text-zinc-500">/month</span>
                <div className="text-sm text-green-400 mt-1">or $490/year (2 months free)</div>
              </div>
              <ul className="mt-6 space-y-3">
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  15 machines, 5 team members
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  1-year session history
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  100,000 messages/month
                </li>
                <li className="flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  API access + priority support
                </li>
              </ul>
              <Link
                href="/login"
                className="mt-8 block w-full rounded-lg bg-zinc-800 py-3 text-center text-sm font-semibold text-zinc-100 hover:bg-zinc-700 transition-colors"
              >
                Start Free Trial
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <div className="rounded-3xl bg-gradient-to-r from-orange-500/20 via-orange-500/10 to-orange-500/20 border border-orange-500/20 p-8 sm:p-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100">
              Ready to Take Control?
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Join developers who use Styrby to stay productive while their agents work.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/login"
                className="rounded-xl bg-orange-500 px-8 py-4 text-base font-semibold text-white shadow-lg shadow-orange-500/20 hover:bg-orange-600 transition-all"
              >
                Start Your Free Trial
              </Link>
              <a
                href="https://github.com/styrby/styrby-cli"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl bg-zinc-800 px-8 py-4 text-base font-semibold text-zinc-100 hover:bg-zinc-700 transition-colors flex items-center justify-center gap-2"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                <span className="text-lg font-bold text-white">S</span>
              </div>
              <span className="font-semibold text-zinc-100">Styrby</span>
            </div>

            <nav className="flex items-center gap-6">
              <a href="#" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                Privacy
              </a>
              <a href="#" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                Terms
              </a>
              <a href="#" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                Docs
              </a>
              <a
                href="https://github.com/styrby"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                GitHub
              </a>
            </nav>

            <p className="text-sm text-zinc-600">
              &copy; 2026 Styrby. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
