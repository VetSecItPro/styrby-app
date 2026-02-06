import { OfflineIndicator } from '@/components/offline-indicator';

/**
 * Dashboard layout wrapper for all authenticated pages.
 *
 * WHY: The OfflineIndicator should only show on authenticated dashboard pages,
 * not on the public landing page or auth pages. By placing it in this layout,
 * it only renders for users who are using the authenticated parts of the app
 * where connection status actually matters.
 */
export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {children}
      <OfflineIndicator />
    </>
  );
}
