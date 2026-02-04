import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TIERS, type TierId } from '@/lib/polar';
import { UpgradeButton } from './upgrade-button';

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
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-zinc-100">
            Choose Your Plan
          </h1>
          <p className="mt-3 text-lg text-zinc-400">
            Upgrade to unlock more features and machines.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {(Object.keys(TIERS) as TierId[]).map((tierId) => {
            const tier = TIERS[tierId];
            const isCurrentTier = currentTier === tierId;
            const isPopular = tierId === 'pro';

            return (
              <div
                key={tierId}
                className={`rounded-2xl p-6 relative ${
                  isPopular
                    ? 'bg-gradient-to-b from-orange-500/10 to-zinc-900 border border-orange-500/20'
                    : 'bg-zinc-900 border border-zinc-800'
                }`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-500 px-3 py-1 text-xs font-medium text-white">
                    Most Popular
                  </div>
                )}

                {isCurrentTier && (
                  <div className="absolute top-4 right-4">
                    <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-400">
                      Current
                    </span>
                  </div>
                )}

                <h3 className="text-xl font-semibold text-zinc-100">{tier.name}</h3>

                <div className="mt-4">
                  <span className="text-4xl font-bold text-zinc-100">${tier.price}</span>
                  <span className="text-zinc-500">/month</span>
                </div>

                <ul className="mt-6 space-y-3">
                  {tier.features.map((feature, index) => (
                    <li key={index} className="flex items-center gap-2 text-sm text-zinc-400">
                      <svg
                        className="h-5 w-5 text-green-500 flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>

                <div className="mt-8">
                  {isCurrentTier ? (
                    <button
                      disabled
                      className="w-full rounded-lg bg-zinc-800 py-3 text-sm font-semibold text-zinc-400 cursor-not-allowed"
                    >
                      Current Plan
                    </button>
                  ) : tierId === 'free' ? (
                    <button
                      disabled
                      className="w-full rounded-lg bg-zinc-800 py-3 text-sm font-semibold text-zinc-400 cursor-not-allowed"
                    >
                      Free Forever
                    </button>
                  ) : (
                    <UpgradeButton tierId={tierId} isPopular={isPopular} />
                  )}
                </div>
              </div>
            );
          })}
        </div>

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
