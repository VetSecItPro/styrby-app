import type { Metadata } from 'next';

/**
 * Layout for the /signup page.
 *
 * WHY: The signup page is a client component (uses useState for form state and
 * useSearchParams for plan param handling). Metadata cannot be exported from
 * client components in Next.js, so it lives here in a server-rendered layout.
 */
export const metadata: Metadata = {
  title: 'Sign Up',
  description:
    'Create a free Styrby account. Connect your AI agents, track costs, and manage sessions from mobile in minutes.',
  openGraph: {
    title: 'Sign Up for Styrby',
    description:
      'Create a free Styrby account. Connect your AI agents, track costs, and manage sessions from mobile in minutes.',
    type: 'website',
    url: 'https://styrbyapp.com/signup',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function SignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
