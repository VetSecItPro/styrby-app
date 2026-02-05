/**
 * QR Code Scanner Screen
 *
 * Scans QR code from CLI to pair devices. After a successful scan, this screen:
 * 1. Decodes and validates the pairing payload
 * 2. Persists pairing info to secure storage
 * 3. Connects to the relay channel for real-time CLI communication
 * 4. Navigates to the main dashboard on success
 *
 * Error states handled:
 * - Camera permission denied
 * - Invalid / malformed QR code
 * - Expired QR code (>5 minutes old)
 * - User ID mismatch (QR from different account)
 * - Network failure during pairing
 * - Already-paired device (offers re-pair)
 */

import { useState, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  decodePairingUrl,
  isPairingExpired,
} from 'styrby-shared';
import {
  executePairing,
  isPaired,
  clearPairingInfo,
} from '../../src/services/pairing';
import { useRelay } from '../../src/hooks/useRelay';

// ============================================================================
// Types
// ============================================================================

/**
 * Tracks the current state of the pairing flow within this screen.
 *
 * - idle: Camera is active, waiting for a scan
 * - processing: QR scanned, executing pairing flow
 * - confirming_repaid: Already paired, asking user to confirm re-pair
 * - success: Pairing complete, navigating away
 * - error: Pairing failed, showing error message
 */
type PairingState = 'idle' | 'processing' | 'confirming_repaid' | 'success' | 'error';

// ============================================================================
// Screen Component
// ============================================================================

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [pairingState, setPairingState] = useState<PairingState>('idle');
  const [error, setError] = useState<string | null>(null);

  /**
   * WHY: useRef instead of useState for the scanned flag to prevent race conditions.
   * The CameraView can fire onBarcodeScanned multiple times before a React state
   * update propagates, leading to duplicate pairing attempts. A ref provides
   * synchronous reads for the guard check.
   */
  const scannedRef = useRef(false);

  /**
   * WHY: Store the pending payload in a ref so the re-pair confirmation flow
   * can access it without triggering a re-render that resets camera state.
   */
  const pendingPayloadRef = useRef<string | null>(null);

  const { savePairing, connect } = useRelay();

  // --------------------------------------------------------------------------
  // Pairing Flow
  // --------------------------------------------------------------------------

  /**
   * Handles the core pairing flow after a QR code is scanned.
   * Validates the QR data, executes the pairing, connects to relay, and navigates.
   *
   * @param data - Raw QR code string data from the camera scanner
   */
  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    // Guard: prevent duplicate scans using synchronous ref check
    if (scannedRef.current) return;
    scannedRef.current = true;

    setError(null);
    setPairingState('processing');

    try {
      // Pre-validate before full pairing (fast feedback for obvious failures)
      const payload = decodePairingUrl(data);

      if (!payload) {
        showError('Invalid QR code. Make sure you are scanning the code from the Styrby CLI.');
        return;
      }

      if (isPairingExpired(payload)) {
        showError('This QR code has expired. Run "styrby pair" in your CLI to generate a new one.');
        return;
      }

      // Check if already paired -- offer re-pair
      const alreadyPaired = await isPaired();
      if (alreadyPaired) {
        pendingPayloadRef.current = data;
        setPairingState('confirming_repaid');
        return;
      }

      // Execute the full pairing flow
      await completePairing(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      showError(message);
    }
  };

  /**
   * Completes the pairing flow: executes the pairing service, saves to relay hook,
   * connects to the relay channel, and navigates to the dashboard.
   *
   * @param qrData - Raw QR code string data
   */
  const completePairing = async (qrData: string) => {
    const result = await executePairing(qrData);

    if (!result.success || !result.pairingInfo) {
      showError(result.error ?? 'Pairing failed. Please try again.');
      return;
    }

    // Save pairing info to the relay hook's state (syncs with useRelay consumers)
    await savePairing({
      userId: result.pairingInfo.userId,
      machineId: result.pairingInfo.machineId,
      deviceName: result.pairingInfo.deviceName,
      pairedAt: result.pairingInfo.pairedAt,
    });

    // Connect to the relay channel
    // WHY: We connect immediately so the CLI sees the mobile device come online
    // in its presence list, confirming the pairing was successful on both sides.
    try {
      await connect();
    } catch {
      // Non-fatal: relay connection can be retried from the dashboard.
      // The pairing data is already saved, so the user is not stuck.
    }

    setPairingState('success');

    // Navigate to the main app after a brief delay for visual feedback
    setTimeout(() => {
      router.replace('/(tabs)');
    }, 500);
  };

  /**
   * Handles the user confirming they want to re-pair (replacing existing pairing).
   */
  const handleConfirmRepair = async () => {
    if (!pendingPayloadRef.current) {
      showError('No QR code data available. Please scan again.');
      return;
    }

    setPairingState('processing');

    // Clear existing pairing data before re-pairing
    await clearPairingInfo();
    await completePairing(pendingPayloadRef.current);
  };

  /**
   * Handles the user canceling the re-pair confirmation.
   */
  const handleCancelRepair = () => {
    pendingPayloadRef.current = null;
    resetScanner();
  };

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Shows an error message and resets the scanner to allow re-scanning.
   *
   * @param message - User-facing error message to display
   */
  const showError = (message: string) => {
    setError(message);
    setPairingState('error');
    // Allow re-scanning after a short delay to prevent accidental immediate re-scan
    setTimeout(() => {
      scannedRef.current = false;
    }, 2000);
  };

  /**
   * Resets the scanner to the idle state, ready for a new scan.
   */
  const resetScanner = () => {
    setError(null);
    setPairingState('idle');
    scannedRef.current = false;
    pendingPayloadRef.current = null;
  };

  // --------------------------------------------------------------------------
  // Permission States
  // --------------------------------------------------------------------------

  // Permission not determined yet
  if (!permission) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-400 mt-4">Requesting camera permission...</Text>
      </View>
    );
  }

  // Permission denied
  if (!permission.granted) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-8">
        <Ionicons name="camera-outline" size={64} color="#71717a" />
        <Text className="text-white text-xl font-semibold text-center mt-4">
          Camera Access Required
        </Text>
        <Text className="text-zinc-400 text-center mt-2 mb-6">
          We need camera access to scan the QR code from your CLI
        </Text>
        <Pressable
          className="bg-brand px-6 py-3 rounded-xl"
          onPress={requestPermission}
          accessibilityLabel="Grant camera permission"
          accessibilityRole="button"
        >
          <Text className="text-white font-semibold">Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Re-pair Confirmation
  // --------------------------------------------------------------------------

  if (pairingState === 'confirming_repaid') {
    return (
      <View className="flex-1 bg-background items-center justify-center px-8">
        <View className="w-16 h-16 rounded-2xl bg-yellow-500/20 items-center justify-center mb-6">
          <Ionicons name="swap-horizontal" size={32} color="#eab308" />
        </View>
        <Text className="text-white text-xl font-bold text-center mb-3">
          Already Paired
        </Text>
        <Text className="text-zinc-400 text-center mb-8">
          This device is already paired with a CLI. Scanning a new QR code will replace the existing pairing.
        </Text>
        <Pressable
          onPress={handleConfirmRepair}
          className="w-full bg-brand py-4 rounded-xl items-center mb-3"
          accessibilityLabel="Replace existing pairing with new CLI"
          accessibilityRole="button"
        >
          <Text className="text-white font-semibold text-base">Replace Pairing</Text>
        </Pressable>
        <Pressable
          onPress={handleCancelRepair}
          className="w-full py-4 rounded-xl items-center border border-zinc-700"
          accessibilityLabel="Cancel and keep existing pairing"
          accessibilityRole="button"
        >
          <Text className="text-zinc-400 font-medium text-base">Keep Existing</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Main Scanner View
  // --------------------------------------------------------------------------

  return (
    <View className="flex-1 bg-background">
      {/* Camera View */}
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={pairingState === 'idle' ? handleBarCodeScanned : undefined}
      />

      {/* Overlay */}
      <View className="flex-1">
        {/* Top overlay */}
        <View className="flex-1 bg-black/60" />

        {/* Middle row with scanner window */}
        <View className="flex-row">
          <View className="flex-1 bg-black/60" />
          <View className="w-72 h-72">
            {/* Scanner frame corners */}
            <View className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-brand rounded-tl-lg" />
            <View className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-brand rounded-tr-lg" />
            <View className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-brand rounded-bl-lg" />
            <View className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-brand rounded-br-lg" />

            {/* Processing overlay on the scanner window */}
            {pairingState === 'processing' && (
              <View className="flex-1 items-center justify-center bg-black/40 rounded-lg">
                <ActivityIndicator size="large" color="#f97316" />
                <Text className="text-white text-sm mt-3">Pairing...</Text>
              </View>
            )}

            {/* Success overlay on the scanner window */}
            {pairingState === 'success' && (
              <View className="flex-1 items-center justify-center bg-black/40 rounded-lg">
                <View className="w-14 h-14 rounded-full bg-green-500/20 items-center justify-center">
                  <Ionicons name="checkmark-circle" size={40} color="#22c55e" />
                </View>
                <Text className="text-green-400 text-sm font-semibold mt-3">Paired</Text>
              </View>
            )}
          </View>
          <View className="flex-1 bg-black/60" />
        </View>

        {/* Bottom overlay with instructions */}
        <View className="flex-1 bg-black/60 items-center pt-8 px-8">
          <Text className="text-white text-lg font-semibold text-center">
            {pairingState === 'processing'
              ? 'Connecting...'
              : pairingState === 'success'
                ? 'Pairing Complete'
                : 'Scan QR Code'}
          </Text>
          <Text className="text-zinc-400 text-center mt-2">
            {pairingState === 'processing' ? (
              'Establishing connection with your CLI'
            ) : pairingState === 'success' ? (
              'Redirecting to dashboard...'
            ) : (
              <>
                Open your CLI and run{' '}
                <Text className="text-brand font-mono">styrby pair</Text>
                {'\n'}to display the QR code
              </>
            )}
          </Text>

          {/* Error message */}
          {error && (
            <View className="mt-4 bg-red-500/20 border border-red-500/30 px-4 py-3 rounded-xl w-full">
              <Text className="text-red-400 text-center">{error}</Text>
              <Pressable
                onPress={resetScanner}
                className="mt-2 items-center"
                accessibilityLabel="Try scanning again"
                accessibilityRole="button"
              >
                <Text className="text-red-300 text-sm font-medium underline">Try Again</Text>
              </Pressable>
            </View>
          )}

          {/* Cancel button */}
          <Pressable
            className="mt-8 px-6 py-3"
            onPress={() => router.back()}
            accessibilityLabel="Cancel QR code scanning"
            accessibilityRole="button"
          >
            <Text className="text-zinc-400 font-medium">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
