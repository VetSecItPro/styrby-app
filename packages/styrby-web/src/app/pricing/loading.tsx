/**
 * Loading state for the Pricing page.
 *
 * Displays a centered spinner while pricing plans and the user's current
 * subscription tier are being fetched.
 */
export default function PricingLoading() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-orange-500"
          role="status"
          aria-label="Loading pricing"
        />
        <p className="text-sm text-zinc-500">Loading Pricing...</p>
      </div>
    </div>
  );
}
