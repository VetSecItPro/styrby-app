import type { Metadata } from 'next';

/**
 * Layout for /invite/* routes.
 *
 * WHY noindex: Team invitation pages contain one-time tokens in the URL and
 * are only meaningful to the invited recipient. They should never appear in
 * search results.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function InviteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
