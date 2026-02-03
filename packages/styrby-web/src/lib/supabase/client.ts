/**
 * Supabase client for browser/client-side usage.
 * Uses the anon key which respects RLS policies.
 *
 * @example
 * const { data, error } = await supabase.from('sessions').select('*');
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Checks if Supabase environment variables are properly configured.
 * Returns false for missing or placeholder values.
 */
function hasValidSupabaseConfig(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Check if values exist and are not placeholders
  if (!url || !key) return false;
  if (url.includes('placeholder') || key.includes('placeholder')) return false;

  return true;
}

// Singleton client instance
let clientInstance: SupabaseClient | null = null;

/**
 * Creates a Supabase client for use in browser components.
 * This client uses the anon key and respects Row Level Security.
 * Returns a mock client in test/CI environments without real credentials.
 *
 * @returns Supabase browser client instance (or mock in test mode)
 */
export function createClient() {
  // Return cached instance if available
  if (clientInstance) return clientInstance;

  // Return mock client in test/CI environment
  if (!hasValidSupabaseConfig()) {
    // Return a minimal mock that won't crash
    return {
      auth: {
        signInWithOtp: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
        signInWithOAuth: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
        getUser: async () => ({ data: { user: null }, error: null }),
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => ({
        select: () => Promise.resolve({ data: [], error: null }),
        insert: () => Promise.resolve({ data: null, error: { message: 'Supabase not configured' } }),
        update: () => Promise.resolve({ data: null, error: { message: 'Supabase not configured' } }),
        delete: () => Promise.resolve({ data: null, error: { message: 'Supabase not configured' } }),
      }),
    } as unknown as SupabaseClient;
  }

  clientInstance = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  return clientInstance;
}
