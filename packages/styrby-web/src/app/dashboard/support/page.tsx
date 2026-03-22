import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SupportListClient } from './support-list-client';

/**
 * Support Tickets List Page (User Side)
 *
 * Server component that fetches the authenticated user's support tickets
 * and delegates rendering to the SupportListClient client component.
 *
 * NOTE: Navigation chrome (sidebar, topnav) is handled by dashboard/layout.tsx.
 */
export default async function SupportPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  const { data: tickets } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  return <SupportListClient tickets={tickets || []} />;
}
