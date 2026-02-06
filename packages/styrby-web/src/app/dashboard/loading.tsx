/**
 * Loading state for the Dashboard page.
 *
 * Displays a centered spinner while the dashboard data (sessions, costs,
 * machines) is being fetched from Supabase.
 */
export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-orange-500"
          role="status"
          aria-label="Loading dashboard"
        />
        <p className="text-sm text-zinc-500">Loading Dashboard...</p>
      </div>
    </div>
  );
}
