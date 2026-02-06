/**
 * Webhooks Settings Page
 *
 * Server component that fetches the user's webhooks and subscription tier.
 * Delegates interactive functionality to the WebhooksClient component.
 *
 * WHY server component: The initial data fetch requires authenticated
 * Supabase queries and tier information for limit display.
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TIERS, type TierId } from '@/lib/polar';
import { WebhooksClient } from './webhooks-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Webhook row from Supabase (excluding secret) */
interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default async function WebhooksPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch webhooks and subscription in parallel
  const [webhooksResult, subscriptionResult] = await Promise.all([
    supabase
      .from('webhooks')
      .select(
        `
        id,
        name,
        url,
        events,
        is_active,
        last_success_at,
        last_failure_at,
        consecutive_failures,
        created_at,
        updated_at
      `
      )
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single(),
  ]);

  const webhooks: WebhookRow[] = webhooksResult.data || [];
  const tier = (subscriptionResult.data?.tier as TierId) || 'free';
  const webhookLimit = TIERS[tier]?.limits.webhooks ?? 0;

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
                href="/dashboard/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link
                href="/dashboard/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
              </Link>
              <Link href="/dashboard/settings" className="text-sm font-medium text-orange-500">
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
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/dashboard/settings"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Settings
          </Link>
          <span className="text-zinc-600">/</span>
          <span className="text-sm text-zinc-300">Webhooks</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100 mb-8">Webhooks</h1>

        <WebhooksClient
          initialWebhooks={webhooks}
          tier={tier}
          webhookLimit={webhookLimit}
          webhookCount={webhooks.length}
        />
      </main>
    </div>
  );
}
