/**
 * Supabase client for browser/client-side usage.
 * Uses the anon key which respects RLS policies.
 *
 * @example
 * const { data, error } = await supabase.from('sessions').select('*');
 */

import { createBrowserClient } from '@supabase/ssr';

/**
 * Creates a Supabase client for use in browser components.
 * This client uses the anon key and respects Row Level Security.
 *
 * @returns Supabase browser client instance
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
