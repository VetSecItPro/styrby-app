'use client';

/**
 * GeneralTab — latest 50 general feedback submissions for the founder dashboard.
 *
 * Displays a table/card list of general feedback sorted by recency.
 * Auto-refreshes every 60 seconds.
 *
 * @module components/dashboard/founder-feedback/GeneralTab
 */

import * as React from 'react';
import { MessageSquare } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface GeneralFeedbackItem {
  id: string;
  user_id: string | null;
  message: string | null;
  platform: string | null;
  context_json: Record<string, unknown> | null;
  created_at: string;
}

interface GeneralTabProps {
  initialItems: GeneralFeedbackItem[];
  initialTotal: number;
}

// ============================================================================
// Component
// ============================================================================

/**
 * General feedback tab for the founder dashboard.
 *
 * @param props - GeneralTabProps
 */
export function GeneralTab({ initialItems, initialTotal }: GeneralTabProps) {
  const [items, setItems] = React.useState<GeneralFeedbackItem[]>(initialItems);
  const [total, setTotal] = React.useState(initialTotal);

  // Auto-refresh every 60 seconds
  React.useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/founder-feedback?tab=general', {
          credentials: 'include',
        });
        if (res.ok) {
          const json = await res.json();
          setItems(json.data.items);
          setTotal(json.data.total);
        }
      } catch {
        // Non-fatal
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <MessageSquare className="mx-auto mb-2 h-8 w-8 text-zinc-600" />
        <p className="text-sm text-zinc-500">No general feedback yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Showing {items.length} of {total} submissions (latest first)
      </p>
      {items.map((item) => (
        <FeedbackCard key={item.id} item={item} />
      ))}
    </div>
  );
}

// ============================================================================
// Sub-component
// ============================================================================

/**
 * Single general feedback card.
 *
 * @param item - GeneralFeedbackItem to display
 */
function FeedbackCard({ item }: { item: GeneralFeedbackItem }) {
  const userRef = item.user_id ? `...${item.user_id.slice(-6)}` : 'anon';
  const screen = item.context_json?.screen as string | undefined;
  const platform = item.platform ?? 'unknown';
  const date = new Date(item.created_at).toLocaleString();

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
        <span>User {userRef}</span>
        <span>-</span>
        <span className="capitalize">{platform}</span>
        {screen && (
          <>
            <span>-</span>
            <span>{screen}</span>
          </>
        )}
        <span className="ml-auto">{date}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
        {item.message ?? '(no message)'}
      </p>
    </div>
  );
}
