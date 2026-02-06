import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TemplatesClient } from './templates-client';
import { contextTemplateFromRow, type ContextTemplateRow } from '@styrby/shared';

/**
 * Templates settings page - manage context templates for agent sessions.
 *
 * Server component that fetches user's context templates from Supabase.
 * Delegates all interactive functionality (create, edit, delete, set default)
 * to the TemplatesClient client component.
 *
 * WHY separate server/client: The initial template list is fetched server-side
 * for fast page load and SEO. All mutations happen client-side with optimistic
 * updates for responsive UX.
 */
export default async function TemplatesPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch all user templates, ordered by creation date (newest first)
  const { data: templateRows } = await supabase
    .from('context_templates')
    .select('*')
    .order('created_at', { ascending: false });

  // Transform database rows to ContextTemplate objects
  const templates = (templateRows || []).map((row) =>
    contextTemplateFromRow(row as ContextTemplateRow)
  );

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link
                href="/dashboard/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
              </Link>
              <Link href="/dashboard/settings" className="text-sm font-medium text-orange-500">
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Breadcrumb */}
      <div className="border-b border-zinc-800 bg-zinc-900/25">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-3">
          <nav className="flex items-center gap-2 text-sm">
            <Link href="/dashboard/settings" className="text-zinc-400 hover:text-zinc-100 transition-colors">
              Settings
            </Link>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-100">Templates</span>
          </nav>
        </div>
      </div>

      {/* Main content */}
      <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
        <TemplatesClient initialTemplates={templates} userId={user.id} />
      </main>
    </div>
  );
}
