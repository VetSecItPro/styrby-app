/**
 * Bridge between the RN app and the iOS home-screen widget.
 *
 * Writes the session-status payload into the shared App Group UserDefaults via
 * `@bacons/apple-targets` ExtensionStorage, then asks WidgetKit to reload its
 * timelines. The Swift widget (targets/widget/StyrbyWidget.swift) reads the
 * same keys back.
 *
 * Everything here is a hard no-op off iOS (Android, web, Expo Go without the
 * dev-client native module). The package is lazy-required inside the iOS guard
 * so it is never loaded under jest/Metro on other platforms.
 *
 * @module lib/widget-bridge
 */

import { Platform } from 'react-native';
import { buildWidgetPayload, type WidgetSessionInput } from './widget-payload';

/**
 * App Group identifier shared by the app target and the widget extension.
 * Must match `ios.entitlements["com.apple.security.application-groups"]` in
 * app.json and the widget target's expo-target.config.js.
 */
export const WIDGET_APP_GROUP = 'group.com.steelmotion.styrby';

/** Minimal shape of the ExtensionStorage API we use (avoids a hard dep type). */
interface ExtensionStorageLike {
  set(key: string, value: string): void;
}
interface ExtensionStorageModule {
  ExtensionStorage: {
    new (appGroup: string): ExtensionStorageLike;
    reloadWidget(): void;
  };
}

/**
 * Publish the most-recent session's status to the iOS widget.
 *
 * @param session - The session to surface, or null to render the empty state.
 */
export function publishWidgetSession(session: WidgetSessionInput | null): void {
  // The widget only exists on iOS; do nothing everywhere else.
  if (Platform.OS !== 'ios') return;

  try {
    // Lazy-require: keeps the native-backed module off the import graph on other
    // platforms and under jest. If the native module is unavailable (Expo Go),
    // construction throws and we swallow it below.
    const mod = require('@bacons/apple-targets') as ExtensionStorageModule;
    const storage = new mod.ExtensionStorage(WIDGET_APP_GROUP);
    const payload = buildWidgetPayload(session);
    for (const [key, value] of Object.entries(payload)) {
      storage.set(key, value);
    }
    mod.ExtensionStorage.reloadWidget();
  } catch (err) {
    // Non-fatal: the widget is a progressive enhancement. Most common cause is
    // running without the dev-client native module (e.g. Expo Go).
    if (__DEV__) console.warn('[widget] publish skipped:', err);
  }
}
