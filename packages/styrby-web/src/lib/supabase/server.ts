/**
 * Supabase client for server-side usage (Server Components, API routes).
 * Handles cookie-based auth for SSR.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Creates a Supabase client for server-side usage.
 * Automatically handles cookie management for auth.
 *
 * @returns Supabase server client instance
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  );
}

/**
 * Creates a Supabase admin client with service role key.
 * Bypasses RLS - use only for trusted server-side operations.
 *
 * WHY the URL fallback: Vercel preview/production scopes only carry
 * `NEXT_PUBLIC_SUPABASE_URL` — not the bare `SUPABASE_URL`. Reading
 * the unprefixed env var alone caused this function to receive
 * `undefined` at runtime in prod (the `!` non-null assertion is a
 * compile-time lie), and `@supabase/ssr` then threw "Your project's
 * URL and Key are required". Falling back to the public-prefixed
 * value is safe because both env vars hold the same Supabase project
 * URL by convention; only the SERVICE ROLE KEY is a secret here.
 *
 * @returns Supabase admin client instance
 */
export function createAdminClient() {
  return createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    }
  );
}
