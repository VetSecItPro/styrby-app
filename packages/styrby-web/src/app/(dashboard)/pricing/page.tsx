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

        {/* FAQ or additional info */}
        <div className="mt-12 text-center">
          <p className="text-zinc-500">
            All plans include a 7-day free trial.{' '}
            <Link href="/settings" className="text-orange-500 hover:text-orange-400">
              Manage your subscription
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
