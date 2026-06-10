/**
 * Supabase middleware helper for refreshing auth sessions.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';

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
 * The validated result of a session refresh pass.
 *
 * WHY the `user` field: protected-route gating in middleware must validate the
 * actual session, not merely the presence of an auth cookie. Returning the
 * `getUser()` result lets the caller gate on a verified user (null = forged,
 * expired, or chunked-but-unverifiable token) instead of pattern-matching a
 * cookie name that an attacker can set or that goes missing for chunked JWTs.
 * (bugs #15, #46)
 */
export interface UpdateSessionResult {
  /** The refreshed Next.js response carrying any rotated auth cookies. */
  response: NextResponse;
  /** The authenticated user, or null when no valid session exists. */
  user: User | null;
}

/**
 * Updates the Supabase auth session by refreshing the token if needed, and
 * returns the validated user so the caller can gate protected routes on a
 * real session rather than cookie presence.
 *
 * @param request - Next.js request object
 * @returns The refreshed response plus the validated user (null if unauthenticated)
 */
export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  let supabaseResponse = NextResponse.next({
    request,
  });

  // Skip session refresh if Supabase is not configured (CI/test environment).
  // WHY user:null here: without config we cannot validate a session, so the
  // gate must fail-closed for protected paths.
  if (!hasValidSupabaseConfig()) {
    return { response: supabaseResponse, user: null };
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

  // Refresh session if expired - this will also update cookies. We keep the
  // validated user so the middleware can gate protected routes on it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response: supabaseResponse, user };
}
