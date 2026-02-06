/**
 * API Keys Settings Page
 *
 * Server component that fetches the user's API keys and subscription tier.
 * Delegates interactive functionality to the ApiKeysClient component.
 *
 * WHY server component: The initial data fetch requires authenticated
 * Supabase queries and tier information for limit display.
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TIERS, type TierId } from '@/lib/polar';
import { ApiKeysClient } from './api-keys-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** API key row from Supabase (without hash) */
interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  last_used_ip: string | null;
  request_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default async function ApiKeysPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch API keys and subscription in parallel
  const [keysResult, subscriptionResult] = await Promise.all([
    supabase
      .from('api_keys')
      .select(
        `
        id,
        name,
        key_prefix,
        scopes,
        last_used_at,
        last_used_ip,
        request_count,
        expires_at,
        revoked_at,
        revoked_reason,
        created_at
      `
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single(),
  ]);

  const keys: ApiKeyRow[] = keysResult.data || [];
  const tier = (subscriptionResult.data?.tier as TierId) || 'free';
  const keyLimit = TIERS[tier]?.limits.apiKeys ?? 0;
  const activeKeys = keys.filter((k) => !k.revoked_at);

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
              <Link
                href="/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
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
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/settings"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Settings
          </Link>
          <span className="text-zinc-600">/</span>
          <span className="text-sm text-zinc-300">API Keys</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100 mb-8">API Keys</h1>

        <ApiKeysClient
          initialKeys={keys}
          tier={tier}
          keyLimit={keyLimit}
          keyCount={activeKeys.length}
        />
      </main>
    </div>
  );
}
