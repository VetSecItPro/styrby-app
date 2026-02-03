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
  const protectedPaths = ['/dashboard', '/settings', '/sessions'];
  const isProtectedPath = protectedPaths.some((path) =>
    request.nextUrl.pathname.startsWith(path)
  );

  if (isProtectedPath) {
    // Check if user is authenticated by looking for session cookie
    const hasSession = request.cookies.has('sb-akmtmxunjhsgldjztdtt-auth-token');

    if (!hasSession) {
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
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$|api/webhooks).*)',
  ],
};
