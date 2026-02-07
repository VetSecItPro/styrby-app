/**
 * Next.js Middleware
 *
 * Runs on every request to:
 * 1. Refresh Supabase auth session
 * 2. Protect dashboard routes (redirect to login if not authenticated)
 */

import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  // Update Supabase auth session
  const response = await updateSession(request);

  // Protected routes that require authentication
  const protectedPaths = ['/dashboard'];
  const isProtectedPath = protectedPaths.some((path) =>
    request.nextUrl.pathname.startsWith(path)
  );

  if (isProtectedPath) {
    /**
     * Derive the Supabase session cookie name from NEXT_PUBLIC_SUPABASE_URL.
     *
     * WHY: Hardcoding the project ref creates a maintenance hazard — if the
     * Supabase project changes (e.g., migration to a new instance), the cookie
     * check silently breaks and all protected routes become inaccessible.
     * Deriving it from the environment variable keeps the middleware in sync
     * with whichever Supabase project is configured.
     *
     * Cookie format: `sb-{project_ref}-auth-token`
     * URL format:    `https://{project_ref}.supabase.co`
     */
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '';
    const cookieName = `sb-${projectRef}-auth-token`;

    // FIX-052: Check both cookie presence AND updateSession result
    // WHY: Cookie presence alone doesn't guarantee the JWT is valid —
    // it could be expired or tampered. updateSession already refreshes
    // the token, but we also check if the response indicates auth failure
    // (e.g., redirect to login means the session refresh failed).
    const hasSession = request.cookies.has(cookieName);
    const isAuthRedirect = response.headers.get('location')?.includes('/login');

    if (!hasSession || isAuthRedirect) {
      // Redirect to login with return URL
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     * - api/webhooks (webhook endpoints don't need auth refresh)
     * - api/cron (cron endpoints use secret-based auth, not session)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$|api/webhooks|api/cron).*)',
  ],
};
