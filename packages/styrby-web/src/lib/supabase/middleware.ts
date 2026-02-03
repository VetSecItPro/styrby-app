/**
 * Supabase middleware helper for refreshing auth sessions.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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

/**
 * Updates the Supabase auth session by refreshing the token if needed.
 * Should be called in middleware for every request.
 *
 * @param request - Next.js request object
 * @returns Next.js response with updated cookies
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  // Skip session refresh if Supabase is not configured (CI/test environment)
  if (!hasValidSupabaseConfig()) {
    return supabaseResponse;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session if expired - this will also update cookies
  await supabase.auth.getUser();

  return supabaseResponse;
}
