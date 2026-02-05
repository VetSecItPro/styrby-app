/**
 * Loading state for the Budget Alerts page.
 *
 * Displays a centered spinner while budget alert data is being fetched
 * from Supabase. Matches the loading pattern used across the dashboard.
 */
export default function BudgetAlertsLoading() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-orange-500"
          role="status"
          aria-label="Loading budget alerts"
        />
        <p className="text-sm text-zinc-500">Loading Budget Alerts...</p>
      </div>
    </div>
  );
}
