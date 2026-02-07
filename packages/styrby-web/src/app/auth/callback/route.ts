/**
 * Auth callback handler for OAuth and magic link flows.
 * Exchanges the auth code for a session and redirects to the destination.
 * Sends welcome email on first login.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { sendWelcomeEmail } from '@/lib/resend';

/**
 * Validates a redirect path to prevent open redirect attacks.
 *
 * WHY: Without validation, an attacker could craft a URL like
 * `/auth/callback?code=...&redirect=https://evil.com` and after
 * successful auth the victim would be sent to the attacker's site.
 *
 * @param path - The redirect path from the query string
 * @returns A safe, relative redirect path (defaults to /dashboard)
 */
function sanitizeRedirect(path: string | null): string {
  if (!path) return '/dashboard';

  // Must start with a single slash (relative path)
  // Must NOT contain `//` (protocol-relative URL or double-slash tricks)
  // Must NOT contain backslashes (some browsers normalize `\` to `/`)
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\')) {
    return '/dashboard';
  }

  return path;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const redirect = sanitizeRedirect(searchParams.get('redirect'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Get user to check if new signup
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        // Check if this is a new user (created within last 60 seconds)
        const createdAt = new Date(user.created_at);
        const now = new Date();
        const isNewUser = (now.getTime() - createdAt.getTime()) < 60000;

        if (isNewUser && user.email) {
          // Send welcome email (fire and forget - don't block redirect)
          const displayName =
            user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            user.email.split('@')[0];

          sendWelcomeEmail({
            email: user.email,
            displayName,
          }).catch((err) => {
            console.error('Failed to send welcome email:', err);
          });
        }
      }

      // Successful auth - redirect to intended destination
      return NextResponse.redirect(`${origin}${redirect}`);
    }
  }

  // Auth failed - redirect to login with error
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
