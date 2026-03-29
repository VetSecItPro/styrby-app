import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Admin layout gate.
 *
 * WHY server-side: The admin API already returns 403 for non-admins,
 * but without a layout gate, non-admin users can still see the admin
 * page skeleton (empty table, filters, etc.). This layout checks
 * profiles.is_admin before rendering any admin page and redirects
 * unauthorized users to the dashboard.
 *
 * Only vetsecitpro@gmail.com has is_admin = true.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Check is_admin flag on profiles table
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();

  if (!profile?.is_admin) {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
