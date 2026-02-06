/**
 * Loading state for the Settings page.
 *
 * Displays a centered spinner while user profile, subscription, notification
 * preferences, and agent configurations are being fetched from Supabase.
 */
export default function SettingsLoading() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-orange-500"
          role="status"
          aria-label="Loading settings"
        />
        <p className="text-sm text-zinc-500">Loading Settings...</p>
      </div>
    </div>
  );
}
