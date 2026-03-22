import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import { TicketDetailClient } from './ticket-detail-client';

/**
 * Support Ticket Detail Page (User Side)
 *
 * Server component that fetches a single ticket and its reply thread.
 * RLS ensures users can only view their own tickets.
 *
 * @param params.id - The ticket UUID from the URL
 */
export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch the ticket (RLS ensures ownership)
  const { data: ticket } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('id', id)
    .single();

  if (!ticket) {
    notFound();
  }

  // Fetch replies in chronological order
  const { data: replies } = await supabase
    .from('support_ticket_replies')
    .select('*')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });

  return (
    <TicketDetailClient
      ticket={ticket}
      replies={replies || []}
      userId={user.id}
    />
  );
}
