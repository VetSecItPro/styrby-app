/**
 * Invite Deep-Link Route — /invite/[token]
 *
 * Expo Router file-based route that handles team invitation deep-links opened
 * from Mail, Messages, or any other app on iOS/Android.
 *
 * URL forms that route here:
 * - Universal Link (iOS):   https://styrbyapp.com/invite/<token>
 * - App Link (Android):     https://styrbyapp.com/invite/<token>
 * - Custom scheme (dev):    styrby://invite/<token>
 * - Direct Expo Router:     /invite/<token> (from useInviteLinkHandler push)
 *
 * WHY a thin route file (orchestrator delegates to InviteAcceptScreen):
 * Expo Router's file-based routing only needs a default-exported component.
 * Keeping all business logic in InviteAcceptScreen (src/components/invite/)
 * allows that component to be tested independently without Expo Router's
 * Stack/Navigator machinery. This file is a pure delegation shim.
 *
 * Flow:
 * 1. Expo Router extracts `token` from the URL path segment
 * 2. InviteAcceptScreen checks auth (redirect to login if not signed in)
 * 3. Calls POST /api/invitations/accept with Bearer token
 * 4. Renders the appropriate state sub-component based on the result
 *
 * @see src/components/invite/InviteAcceptScreen.tsx — all business logic
 * @see src/hooks/useInviteLinkHandler.ts — cold/warm start URL interception
 */

import React from 'react';
import { InviteAcceptScreen } from '../../src/components/invite';

/**
 * Expo Router default export for the /invite/[token] route.
 *
 * The `token` path segment is automatically provided as a route param and
 * consumed by InviteAcceptScreen via useLocalSearchParams().
 *
 * @returns React element
 */
export default function InviteTokenRoute(): React.ReactElement {
  return <InviteAcceptScreen />;
}
