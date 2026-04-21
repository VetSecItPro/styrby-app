/**
 * Gemini Session Bootstrap
 *
 * Encapsulates the "before-the-main-loop" setup work that `runGemini` used
 * to do inline: ApiClient creation, machine registration, cloud-token fetch
 * (with email decoding), session metadata + offline reconnection wiring,
 * and the daemon notification.
 *
 * WHY split out: This was ~120 lines of straight-line setup with no shared
 * mutation, so it pulls out as a pure-ish async function that returns a
 * struct of everything the orchestrator needs.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { type Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';

import { decodeEmailFromIdToken } from '@/gemini/utils/idTokenEmail';

export interface GeminiBootstrapResult {
  api: ApiClient;
  machineId: string;
  cloudToken?: string;
  currentUserEmail?: string;
  sessionTag: string;
  metadata: ReturnType<typeof createSessionMetadata>['metadata'];
  state: ReturnType<typeof createSessionMetadata>['state'];
  /** The initial session client (may be an offline stub). */
  initialSession: ApiSessionClient;
  /** Handle to cancel offline reconnection during cleanup. */
  reconnectionHandle: { cancel: () => void } | undefined;
}

/**
 * Run the full Gemini session bootstrap sequence.
 *
 * Side effects (matching pre-refactor behavior):
 *   - Calls `connectionState.setBackend('Gemini')`
 *   - Logs to debug logger
 *   - May `process.exit(1)` if no machineId is in settings
 *   - Notifies daemon (best effort)
 *
 * @param opts.credentials - Auth credentials passed by the CLI shell.
 * @param opts.startedBy   - Whether this run came from 'daemon' or 'terminal'.
 * @param opts.onSessionSwap - Callback invoked when offline reconnection
 *   produces a new live `ApiSessionClient` (the orchestrator's swap logic).
 */
export async function bootstrapGeminiSession(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  onSessionSwap: (newSession: ApiSessionClient) => void;
}): Promise<GeminiBootstrapResult> {
  const sessionTag = randomUUID();

  // Set backend for offline warnings (before any API calls)
  connectionState.setBackend('Gemini');

  const api = await ApiClient.create(opts.credentials);

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(
      `[START] No machine ID found in settings, which is unexpected since ` +
      `authAndSetupMachineIfNeeded should have created it. ` +
      `Please report this issue on https://github.com/slopus/happy-cli/issues`,
    );
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata,
  });

  // Fetch Gemini cloud token (from 'happy connect gemini')
  let cloudToken: string | undefined;
  let currentUserEmail: string | undefined;
  try {
    const vendorToken = await api.getVendorToken('gemini');
    if (vendorToken?.oauth?.access_token) {
      cloudToken = vendorToken.oauth.access_token;
      logger.debug('[Gemini] Using OAuth token from Happy cloud');

      // WHY: Per-account project matching needs the Google identity. Decode
      // the id_token (JWT) without verifying — used only for routing.
      currentUserEmail = decodeEmailFromIdToken(vendorToken.oauth.id_token);
      if (currentUserEmail) {
        logger.debug(`[Gemini] Current user email: ${currentUserEmail}`);
      } else if (vendorToken.oauth.id_token) {
        logger.debug('[Gemini] Failed to decode id_token for email');
      }
    }
  } catch (error) {
    logger.debug('[Gemini] Failed to fetch cloud token:', error);
  }

  // Create session
  const { state, metadata } = createSessionMetadata({
    flavor: 'gemini',
    machineId,
    startedBy: opts.startedBy,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: opts.onSessionSwap,
  });

  // Report to daemon (only if we have a real session)
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
      } else {
        logger.debug(`[START] Reported session ${response.id} to daemon`);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }
  }

  return {
    api,
    machineId,
    cloudToken,
    currentUserEmail,
    sessionTag,
    metadata,
    state,
    initialSession,
    reconnectionHandle,
  };
}
