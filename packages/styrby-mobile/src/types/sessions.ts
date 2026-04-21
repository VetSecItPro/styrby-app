/**
 * Sessions screen type definitions.
 *
 * WHY: Per CLAUDE.md "Component-First Architecture", shared types live in
 * src/types/{domain}.ts so they are not redeclared inline across multiple
 * sub-components.
 */

import type { SessionRow } from '../hooks/useSessions';
import type { ConnectionStatus } from '../hooks/useSessionConnectionState';

/**
 * Section shape for the SectionList. Each section contains a date label,
 * session count, and the sessions that started on that date.
 */
export interface SessionSection {
  /** Human-friendly date label (e.g. "Today", "Yesterday", "Mon Mar 25") */
  title: string;
  /** Number of sessions in this section */
  count: number;
  /** Sessions in this section */
  data: SessionRow[];
}

/**
 * Props for the SessionCard component.
 */
export interface SessionCardProps {
  /** The session data to render */
  session: SessionRow;
  /** Callback fired when the card is tapped */
  onPress: (session: SessionRow) => void;
  /** Whether this session is currently bookmarked */
  isBookmarked: boolean;
  /** Whether the bookmark API call is in flight (shows subtle opacity) */
  isTogglingBookmark: boolean;
  /** Optional error message for the last failed bookmark toggle */
  bookmarkError: string | undefined;
  /** Callback fired when the bookmark star is tapped */
  onBookmarkPress: (sessionId: string) => void;
  /**
   * Optional daemon connection status for the session.
   * When provided, a small dot indicator is rendered in the badges row.
   * Only meaningful for active sessions (starting/running/idle/paused).
   */
  connectionStatus?: ConnectionStatus;
  /** Last time the daemon sent a heartbeat (shown for offline sessions). */
  connectionLastSeenAt?: Date | null;
}
