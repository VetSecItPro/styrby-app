/**
 * Shared Session Viewer
 *
 * Public page that displays a shared session replay. The messages are
 * E2E encrypted - the viewer must enter the decryption key to read them.
 *
 * WHY client component: Key entry, decryption, and the message display
 * are all client-side operations. We fetch the encrypted session data
 * server-side for fast initial load, then hand off to the client.
 *
 * @route GET /shared/:shareId
 * @auth None required (public)
 */

import type { Metadata } from 'next';
import { SharedSessionViewer } from './shared-session-viewer';

/**
 * Generates per-page metadata for shared session pages.
 *
 * WHY noindex: Shared session URLs contain unique share tokens and their
 * content is user-generated. Indexing them provides no SEO value and could
 * surface private developer conversations in search results.
 *
 * @param props - Page props with shareId in params
 * @returns Metadata with a descriptive title and noindex robots directive
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  return {
    title: `Shared Session | Styrby`,
    description: `View a shared AI agent session on Styrby. Share ID: ${shareId}`,
    robots: {
      index: false,
      follow: false,
    },
  };
}

/**
 * Props for the shared session page.
 */
interface SharedSessionPageProps {
  params: Promise<{ shareId: string }>;
}

/**
 * Renders the shared session viewer page.
 *
 * @param props - Page props with shareId in params
 */
export default async function SharedSessionPage({ params }: SharedSessionPageProps) {
  const { shareId } = await params;
  return <SharedSessionViewer shareId={shareId} />;
}
