import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { type TierId } from '@/lib/polar';
import { PricingCards } from './pricing-cards';

/**
 * Pricing page - subscription tiers and upgrade options.
 */
export default async function PricingPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Get current subscription
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .single();

  const currentTier = (subscription?.tier as TierId) || 'free';

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/settings"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-zinc-100">
            Choose Your Plan
          </h1>
          <p className="mt-3 text-lg text-zinc-400">
            Upgrade to unlock more features and machines.
          </p>
        </div>

        {/* Pricing cards with billing toggle */}
        <PricingCards currentTier={currentTier} />

        {/* Limits comparison table */}
        <div className="mt-16">
          <h2 className="text-xl font-semibold text-zinc-100 text-center mb-8">
            Compare Plans
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left py-3 px-4 text-zinc-400 font-medium">Feature</th>
                  <th className="text-center py-3 px-4 text-zinc-400 font-medium">Free</th>
                  <th className="text-center py-3 px-4 text-zinc-400 font-medium">Pro</th>
                  <th className="text-center py-3 px-4 text-zinc-400 font-medium">Power</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                <tr>
                  <td className="py-3 px-4 text-zinc-300">Connected machines</td>
                  <td className="py-3 px-4 text-center text-zinc-400">1</td>
                  <td className="py-3 px-4 text-center text-zinc-100">5</td>
                  <td className="py-3 px-4 text-center text-zinc-100">15</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-zinc-300">Session history</td>
                  <td className="py-3 px-4 text-center text-zinc-400">7 days</td>
                  <td className="py-3 px-4 text-center text-zinc-100">90 days</td>
                  <td className="py-3 px-4 text-center text-zinc-100">1 year</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-zinc-300">Messages/month</td>
                  <td className="py-3 px-4 text-center text-zinc-400">1,000</td>
                  <td className="py-3 px-4 text-center text-zinc-100">25,000</td>
                  <td className="py-3 px-4 text-center text-zinc-100">100,000</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-zinc-300">Budget alerts</td>
                  <td className="py-3 px-4 text-center text-zinc-500">-</td>
                  <td className="py-3 px-4 text-center text-zinc-100">3</td>
                  <td className="py-3 px-4 text-center text-zinc-100">10</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-zinc-300">Team members</td>
                  <td className="py-3 px-4 text-center text-zinc-500">-</td>
                  <td className="py-3 px-4 text-center text-zinc-500">-</td>
                  <td className="py-3 px-4 text-center text-zinc-100">5</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-zinc-300">API access</td>
                  <td className="py-3 px-4 text-center text-zinc-500">-</td>
                  <td className="py-3 px-4 text-center text-zinc-500">-</td>
                  <td className="py-3 px-4 text-center text-green-500">Yes</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 text-zinc-300">Support</td>
                  <td className="py-3 px-4 text-center text-zinc-500">-</td>
                  <td className="py-3 px-4 text-center text-zinc-100">Email</td>
                  <td className="py-3 px-4 text-center text-zinc-100">Priority email</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ */}
        <div className="mt-12 text-center">
          <p className="text-zinc-500">
            Questions?{' '}
            <a href="mailto:support@styrby.dev" className="text-orange-500 hover:text-orange-400">
              Contact support
            </a>
            {' '}or{' '}
            <Link href="/settings" className="text-orange-500 hover:text-orange-400">
              manage your subscription
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
