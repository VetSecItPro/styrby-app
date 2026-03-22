import type { Metadata } from 'next';

/**
 * Layout for the /login page.
 *
 * WHY: The login page is a client component (uses useState for form state and
 * useSearchParams for redirect handling). Metadata cannot be exported from
 * client components in Next.js, so it lives here in a server-rendered layout.
 */
export const metadata: Metadata = {
  title: 'Log In',
  description:
    'Log in to your Styrby account to manage AI agents, review session costs, and control your coding workflow from any device.',
  openGraph: {
    title: 'Log In to Styrby',
    description:
      'Log in to your Styrby account to manage AI agents, review session costs, and control your coding workflow from any device.',
    type: 'website',
    url: 'https://styrbyapp.com/login',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
