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

import { SharedSessionViewer } from './shared-session-viewer';

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
