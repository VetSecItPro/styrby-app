import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

/**
 * Settings page - user preferences and account settings.
 */
export default async function SettingsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch user profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  // Fetch subscription
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Fetch notification preferences
  const { data: notificationPrefs } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Fetch agent configs
  const { data: agentConfigs } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('user_id', user.id);

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
                href="/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link href="/settings" className="text-sm font-medium text-orange-500">
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
      <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-zinc-100 mb-8">Settings</h1>

        {/* Account Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Account</h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
            {/* Email */}
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Email</p>
                <p className="text-sm text-zinc-500">{user.email}</p>
              </div>
              <button className="text-sm text-orange-500 hover:text-orange-400">
                Change
              </button>
            </div>

            {/* Display name */}
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Display Name</p>
                <p className="text-sm text-zinc-500">
                  {profile?.display_name || 'Not set'}
                </p>
              </div>
              <button className="text-sm text-orange-500 hover:text-orange-400">
                Edit
              </button>
            </div>

            {/* Password */}
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Password</p>
                <p className="text-sm text-zinc-500">
                  {user.app_metadata?.provider === 'github'
                    ? 'Signed in with GitHub'
                    : '••••••••'}
                </p>
              </div>
              {user.app_metadata?.provider !== 'github' && (
                <button className="text-sm text-orange-500 hover:text-orange-400">
                  Change
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Subscription Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Subscription</h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-lg font-semibold text-zinc-100 capitalize">
                    {subscription?.tier || 'Free'} Plan
                  </p>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      subscription?.status === 'active'
                        ? 'bg-green-500/10 text-green-400'
                        : subscription?.status === 'trialing'
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'bg-zinc-700 text-zinc-400'
                    }`}
                  >
                    {subscription?.status || 'Free'}
                  </span>
                </div>
                {subscription?.current_period_end && (
                  <p className="text-sm text-zinc-500 mt-1">
                    {subscription.cancel_at_period_end
                      ? 'Cancels'
                      : 'Renews'}{' '}
                    on{' '}
                    {new Date(subscription.current_period_end).toLocaleDateString()}
                  </p>
                )}
              </div>
              <button className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors">
                {subscription?.tier === 'free' || !subscription
                  ? 'Upgrade'
                  : 'Manage'}
              </button>
            </div>

            {/* Usage */}
            {subscription && subscription.tier !== 'free' && (
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <p className="text-sm text-zinc-500">
                  This month&apos;s usage: $12.45 / $50.00 included
                </p>
                <div className="mt-2 h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-orange-500 rounded-full"
                    style={{ width: '24.9%' }}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Notifications Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Notifications</h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
            {/* Push notifications */}
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">
                  Push Notifications
                </p>
                <p className="text-sm text-zinc-500">
                  Get notified when agents need attention
                </p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  defaultChecked={notificationPrefs?.push_enabled ?? true}
                />
                <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
              </label>
            </div>

            {/* Email notifications */}
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">
                  Email Notifications
                </p>
                <p className="text-sm text-zinc-500">
                  Weekly summary and important alerts
                </p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  defaultChecked={notificationPrefs?.email_enabled ?? true}
                />
                <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
              </label>
            </div>

            {/* Quiet hours */}
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Quiet Hours</p>
                <p className="text-sm text-zinc-500">
                  {notificationPrefs?.quiet_hours_start && notificationPrefs?.quiet_hours_end
                    ? `${notificationPrefs.quiet_hours_start} - ${notificationPrefs.quiet_hours_end}`
                    : 'Not configured'}
                </p>
              </div>
              <button className="text-sm text-orange-500 hover:text-orange-400">
                Configure
              </button>
            </div>
          </div>
        </section>

        {/* Agent Settings Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">Agent Settings</h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
            {['claude', 'codex', 'gemini'].map((agent) => {
              const config = agentConfigs?.find((c) => c.agent_type === agent);
              return (
                <div
                  key={agent}
                  className="px-4 py-4 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                        agent === 'claude'
                          ? 'bg-orange-500/10'
                          : agent === 'codex'
                            ? 'bg-green-500/10'
                            : 'bg-blue-500/10'
                      }`}
                    >
                      <span
                        className={`text-sm font-bold ${
                          agent === 'claude'
                            ? 'text-orange-400'
                            : agent === 'codex'
                              ? 'text-green-400'
                              : 'text-blue-400'
                        }`}
                      >
                        {agent[0].toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-100 capitalize">
                        {agent}
                      </p>
                      <p className="text-sm text-zinc-500">
                        {config?.auto_approve_low_risk
                          ? 'Auto-approve low risk'
                          : 'Manual approval'}
                      </p>
                    </div>
                  </div>
                  <button className="text-sm text-orange-500 hover:text-orange-400">
                    Configure
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Danger Zone */}
        <section>
          <h2 className="text-lg font-semibold text-red-400 mb-4">Danger Zone</h2>
          <div className="rounded-xl bg-zinc-900 border border-red-500/30 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Delete Account</p>
                <p className="text-sm text-zinc-500">
                  Permanently delete your account and all data
                </p>
              </div>
              <button className="rounded-lg border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors">
                Delete Account
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
