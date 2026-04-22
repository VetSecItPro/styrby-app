/**
 * `styrby pair` command handler.
 *
 * Generates a QR code pairing payload, displays it in the terminal, then
 * waits on a Supabase Realtime channel for the mobile app to join. When
 * the mobile app joins, sends a "ping" to confirm the bridge, persists
 * the pairedAt timestamp, and exits.
 *
 * @module cli/handlers/pair
 */

import { logger } from '@/ui/logger';
import { Logger } from '@styrby/shared/logging';
import { getSentryAdapter } from '@/observability/sentry';

/**
 * Structured logger for pair command events.
 * WHY: pair events are critical — a failed pairing means the user is locked
 * out until they re-run the command. Structured logs let the founder see
 * pairing success/failure rates without waiting for support tickets.
 */
const pairLog = new Logger({
  minLevel: process.env.STYRBY_LOG_LEVEL === 'debug' ? 'debug' : 'info',
  sentry: getSentryAdapter(),
});

/**
 * Handle the `styrby pair` command.
 *
 * WHY this sits in its own module: the flow is subtle (QR render +
 * presence subscription + SIGINT handling + timeout race) and used to
 * account for ~130 LOC of `index.ts`. Isolating it makes the entry
 * point easier to audit.
 */
export async function handlePair(): Promise<void> {
  const qrcode = await import('qrcode-terminal');
  const os = await import('os');
  const crypto = await import('crypto');
  const { createClient } = await import('@supabase/supabase-js');
  const chalk = (await import('chalk')).default;

  // Import pairing utilities from shared package
  const { encodePairingUrl, generatePairingToken, PAIRING_EXPIRY_MINUTES, createRelayClient } = await import('styrby-shared');

  // Load stored credentials
  const { loadPersistedData, savePersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    logger.error('Not authenticated. Please run "styrby onboard" first.');
    process.exit(1);
  }

  // Generate pairing payload
  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();
  const token = generatePairingToken();

  const { config } = await import('@/env');
  const supabaseUrl = config.supabaseUrl;
  const supabaseAnonKey = config.supabaseAnonKey;

  const payload = {
    version: 1 as const,
    token,
    userId: data.userId,
    machineId,
    deviceName,
    supabaseUrl,
    expiresAt: new Date(Date.now() + PAIRING_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };

  const pairingUrl = encodePairingUrl(payload);

  // Display QR code
  console.log('\n');
  logger.info('Scan this QR code with the Styrby mobile app:\n');

  qrcode.generate(pairingUrl, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log('\n');
  console.log(`Machine: ${deviceName}`);
  console.log(`Expires: ${PAIRING_EXPIRY_MINUTES} minutes`);
  console.log('\nWaiting for mobile app to connect...');
  console.log('(Press Ctrl+C to cancel)\n');

  // Create authenticated Supabase client
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  // Create relay client and wait for mobile presence
  const relay = createRelayClient({
    supabase,
    userId: data.userId,
    deviceId: machineId,
    deviceType: 'cli',
    deviceName,
    platform: process.platform,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  try {
    await relay.connect();

    // Wait for mobile device to join (5 minute timeout)
    const timeoutMs = PAIRING_EXPIRY_MINUTES * 60 * 1000;
    const paired = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      // Check if mobile is already connected
      if (relay.isDeviceTypeOnline('mobile')) {
        clearTimeout(timeout);
        resolve(true);
        return;
      }

      // Wait for mobile to join
      const onJoin = (presence: { device_type: string }) => {
        if (presence.device_type === 'mobile') {
          clearTimeout(timeout);
          relay.off('presence_join', onJoin);
          resolve(true);
        }
      };

      relay.on('presence_join', onJoin);

      // Handle Ctrl+C gracefully
      const onInterrupt = () => {
        clearTimeout(timeout);
        relay.off('presence_join', onJoin);
        process.off('SIGINT', onInterrupt);
        resolve(false);
      };

      process.on('SIGINT', onInterrupt);
    });

    if (paired) {
      // Send test ping
      await relay.sendCommand('ping');
      pairLog.info('pair.success', { userId: data.userId, machineId });
      console.log(chalk.green('\nSUCCESS! Mobile paired successfully.\n'));

      // Save pairing timestamp
      savePersistedData({
        pairedAt: new Date().toISOString(),
      });
    } else {
      pairLog.warn('pair.timeout_or_cancelled', { userId: data.userId, machineId });
      console.log(chalk.yellow('\nPairing timed out or cancelled.\n'));
      console.log('You can try again with: styrby pair\n');
    }
  } catch (error) {
    pairLog.error(
      'pair.failed',
      { userId: data.userId, machineId },
      error instanceof Error ? error : new Error(String(error)),
    );
    logger.debug('Pairing error', { error });
    console.log(chalk.red('\nPairing failed. Please try again.\n'));
  } finally {
    await relay.disconnect();
  }
}
