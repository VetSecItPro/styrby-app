import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DashboardShell } from './dashboard-shell';

/**
 * Dashboard layout - server component that checks auth, then renders the
 * client-side shell with sidebar, topnav, mobile nav, and command palette.
 *
 * WHY server component wrapper: We need server-side auth verification before
 * rendering any dashboard content. The middleware cookie check is a fast-path
 * guard, but this layout does the authoritative getUser() call. The actual
 * UI chrome (sidebar collapse state, mobile nav toggle) requires client-side
 * interactivity, so we delegate to DashboardShell.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  return <DashboardShell>{children}</DashboardShell>;
}
