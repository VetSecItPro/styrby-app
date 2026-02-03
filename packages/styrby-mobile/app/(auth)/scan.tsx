/**
 * QR Code Scanner Screen
 *
 * Scans QR code from CLI to pair devices.
 */

import { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  decodePairingUrl,
  isPairingExpired,
  type PairingPayload,
} from 'styrby-shared';

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle QR code scan
  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    setError(null);

    try {
      // Decode the pairing URL
      const payload = decodePairingUrl(data);

      if (!payload) {
        setError('Invalid QR code. Please try again.');
        setScanned(false);
        return;
      }

      // Check if expired
      if (isPairingExpired(payload)) {
        setError('QR code expired. Generate a new one from CLI.');
        setScanned(false);
        return;
      }

      // TODO: Complete pairing flow
      // 1. Verify token with backend
      // 2. Store pairing info
      // 3. Connect to relay channel

      console.log('Pairing payload:', payload);

      // Navigate to success screen or main app
      router.replace('/(tabs)');
    } catch (err) {
      console.error('Scan error:', err);
      setError('Failed to process QR code. Please try again.');
      setScanned(false);
    }
  };

  // Permission not determined yet
  if (!permission) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-white">Requesting camera permission...</Text>
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
        >
          <Text className="text-white font-semibold">Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Camera View */}
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
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
          </View>
          <View className="flex-1 bg-black/60" />
        </View>

        {/* Bottom overlay with instructions */}
        <View className="flex-1 bg-black/60 items-center pt-8 px-8">
          <Text className="text-white text-lg font-semibold text-center">
            Scan QR Code
          </Text>
          <Text className="text-zinc-400 text-center mt-2">
            Open your CLI and run{' '}
            <Text className="text-brand font-mono">styrby pair</Text>
            {'\n'}to display the QR code
          </Text>

          {/* Error message */}
          {error && (
            <View className="mt-4 bg-red-500/20 border border-red-500/30 px-4 py-3 rounded-xl">
              <Text className="text-red-400 text-center">{error}</Text>
            </View>
          )}

          {/* Cancel button */}
          <Pressable
            className="mt-8 px-6 py-3"
            onPress={() => router.back()}
          >
            <Text className="text-zinc-400 font-medium">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
