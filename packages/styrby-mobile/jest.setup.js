/**
 * Jest Setup File for Styrby Mobile
 *
 * Registers global mocks for native modules that are not available in the
 * Jest/node test environment. Each mock provides a minimal, deterministic
 * implementation sufficient for unit tests.
 *
 * WHY variable names start with "mock": Babel hoists jest.mock() calls to
 * the top of the file, which means variables referenced inside the factory
 * function must be in scope at that point. Babel allows variables prefixed
 * with "mock" (case-insensitive) as an escape hatch.
 */

// ============================================================================
// expo-secure-store
// ============================================================================

/**
 * In-memory mock of expo-secure-store.
 * Uses a Map to simulate the device's secure keychain.
 * WHY "mock" prefix: required by Babel's jest.mock() hoisting rules.
 */
const mockSecureStoreData = new Map();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key) => mockSecureStoreData.get(key) ?? null),
  setItemAsync: jest.fn(async (key, value) => {
    mockSecureStoreData.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key) => {
    mockSecureStoreData.delete(key);
  }),
}));

// ============================================================================
// expo-notifications
// ============================================================================

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[mock-token]' })),
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => 'mock-notification-id'),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  cancelAllScheduledNotificationsAsync: jest.fn(async () => {}),
  getBadgeCountAsync: jest.fn(async () => 0),
  setBadgeCountAsync: jest.fn(async () => true),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  removeNotificationSubscription: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  AndroidImportance: { MAX: 5, HIGH: 4 },
  AndroidNotificationPriority: { HIGH: 'high' },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

// ============================================================================
// expo-device
// ============================================================================

jest.mock('expo-device', () => ({
  isDevice: true,
  brand: 'Apple',
  modelName: 'iPhone 15',
  osName: 'iOS',
  osVersion: '17.0',
}));

// ============================================================================
// @react-native-community/netinfo
// ============================================================================

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn(async () => ({
    isConnected: true,
    isInternetReachable: true,
    type: 'wifi',
  })),
}));

// ============================================================================
// expo-sqlite
// ============================================================================

const mockSqliteRows = new Map();

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => {}),
    runAsync: jest.fn(async (sql, params) => {
      if (sql.includes('INSERT')) {
        mockSqliteRows.set(params[0], {
          id: params[0],
          message: params[1],
          status: params[2],
          attempts: params[3],
          max_attempts: params[4],
          created_at: params[5],
          expires_at: params[6],
          priority: params[7],
        });
        return { changes: 1 };
      }
      if (sql.includes('UPDATE')) {
        return { changes: 1 };
      }
      if (sql.includes('DELETE')) {
        return { changes: mockSqliteRows.size };
      }
      return { changes: 0 };
    }),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
  })),
}));

// ============================================================================
// expo-clipboard
// ============================================================================

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
  getStringAsync: jest.fn(async () => ''),
}));

// ============================================================================
// expo-haptics
// ============================================================================

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 0, Medium: 1, Heavy: 2 },
  NotificationFeedbackType: { Success: 0, Warning: 1, Error: 2 },
}));

// ============================================================================
// expo-camera
// ============================================================================

jest.mock('expo-camera', () => ({
  useCameraPermissions: jest.fn(() => [{ granted: true }, jest.fn()]),
  CameraView: 'CameraView',
}));

// ============================================================================
// expo-passkey (WebAuthn L3 native bridge)
// ============================================================================

/**
 * Mock of expo-passkey default export.
 * WHY: The real module imports a Turbo/Expo native module at import time,
 * which fails in the node test environment. This mock provides the same
 * shape (default export with createPasskey / authenticateWithPasskey) and
 * returns JSON strings, matching the production contract.
 * Tests that exercise enrollment/authentication override these with
 * jest.mock('expo-passkey', ...) locally.
 */
// WHY mocking 'expo-passkey' (not '/native'): Metro resolves the bare package
// name on native platforms to build/index.native.js via platform-aware
// resolution. Our app code imports from 'expo-passkey' to match that.
jest.mock('expo-passkey', () => ({
  __esModule: true,
  default: {
    isPasskeySupported: jest.fn(() => true),
    createPasskey: jest.fn(async () => JSON.stringify({ id: 'mock-cred', type: 'public-key' })),
    authenticateWithPasskey: jest.fn(async () => JSON.stringify({ id: 'mock-cred', type: 'public-key' })),
  },
}));

// ============================================================================
// expo-linking
// ============================================================================

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => {}),
  createURL: jest.fn((path) => `styrby://${path}`),
}));

// ============================================================================
// react-native (comprehensive mock for node environment)
// ============================================================================

jest.mock('react-native', () => {
  const React = require('react');

  /**
   * Creates a simple mock React component that renders its children.
   *
   * @param name - The component display name
   * @returns A mock functional component
   */
  const mockComponent = (name) => {
    const Component = (props) =>
      React.createElement(name, props, props.children);
    Component.displayName = name;
    return Component;
  };

  return {
    Platform: { OS: 'ios', select: jest.fn((obj) => obj.ios) },
    AppState: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      currentState: 'active',
    },
    StyleSheet: { create: (styles) => styles, flatten: (style) => style },
    Appearance: { getColorScheme: jest.fn(() => 'dark') },
    Dimensions: { get: jest.fn(() => ({ width: 390, height: 844 })) },
    PixelRatio: { get: jest.fn(() => 3), getFontScale: jest.fn(() => 1), getPixelSizeForLayoutSize: jest.fn((size) => size * 3), roundToNearestPixel: jest.fn((size) => size) },
    Alert: { alert: jest.fn() },
    Linking: { openURL: jest.fn(async () => {}), addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    UIManager: { getViewManagerConfig: jest.fn(() => ({})), setLayoutAnimationEnabledExperimental: jest.fn() },
    NativeModules: {},
    NativeEventEmitter: jest.fn(() => ({ addListener: jest.fn(() => ({ remove: jest.fn() })), removeAllListeners: jest.fn() })),
    // Core components as mock components
    View: mockComponent('View'),
    Text: mockComponent('Text'),
    ScrollView: mockComponent('ScrollView'),
    FlatList: (props) => {
      const items = (props.data || []).map((item, index) =>
        props.renderItem ? props.renderItem({ item, index, separators: {} }) : null
      );
      const empty = (!props.data || props.data.length === 0) && props.ListEmptyComponent
        ? (typeof props.ListEmptyComponent === 'function' ? React.createElement(props.ListEmptyComponent) : props.ListEmptyComponent)
        : null;
      return React.createElement('FlatList', null, ...items, empty, props.ListFooterComponent || null);
    },
    SectionList: (props) => {
      const items = [];
      for (const section of (props.sections || [])) {
        if (props.renderSectionHeader) {
          items.push(props.renderSectionHeader({ section }));
        }
        for (let index = 0; index < section.data.length; index++) {
          if (props.renderItem) {
            items.push(props.renderItem({ item: section.data[index], index, section, separators: {} }));
          }
        }
      }
      const empty = (!props.sections || props.sections.length === 0 || props.sections.every((s) => s.data.length === 0))
        && props.ListEmptyComponent
        ? (typeof props.ListEmptyComponent === 'function' ? React.createElement(props.ListEmptyComponent) : props.ListEmptyComponent)
        : null;
      return React.createElement('SectionList', null, ...items, empty);
    },
    Pressable: mockComponent('Pressable'),
    TouchableOpacity: mockComponent('TouchableOpacity'),
    TextInput: mockComponent('TextInput'),
    Switch: mockComponent('Switch'),
    Modal: mockComponent('Modal'),
    ActivityIndicator: mockComponent('ActivityIndicator'),
    RefreshControl: mockComponent('RefreshControl'),
    KeyboardAvoidingView: mockComponent('KeyboardAvoidingView'),
    Image: mockComponent('Image'),
    StatusBar: mockComponent('StatusBar'),
    SafeAreaView: mockComponent('SafeAreaView'),
  };
});

// ============================================================================
// react-native-css-interop (NativeWind runtime)
// ============================================================================

/**
 * WHY: NativeWind uses react-native-css-interop at runtime. The library
 * accesses Appearance.getColorScheme() at import time, which fails in
 * node environments. Mocking the entire package avoids this.
 */
jest.mock('react-native-css-interop', () => ({
  cssInterop: jest.fn((component) => component),
  remapProps: jest.fn((component) => component),
  useColorScheme: jest.fn(() => ({ colorScheme: 'dark', setColorScheme: jest.fn(), toggleColorScheme: jest.fn() })),
  useUnstableNativeVariable: jest.fn(() => ''),
  vars: jest.fn((style) => style),
  StyleSheet: { create: (styles) => styles },
}));

// ============================================================================
// __DEV__ global
// ============================================================================

global.__DEV__ = true;

// ============================================================================
// Process.env defaults for tests
// ============================================================================

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://test-project.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.EXPO_PUBLIC_PROJECT_ID = 'test-project-id';

// ============================================================================
// Cleanup helpers (called manually in tests or via setupFilesAfterFramework)
// ============================================================================

/**
 * Resets the SecureStore mock data.
 * Call in beforeEach/afterEach in tests that use SecureStore.
 */
global.__resetSecureStore = () => mockSecureStoreData.clear();

// ============================================================================
// requestAnimationFrame / cancelAnimationFrame polyfill
// ============================================================================

/**
 * WHY: Some React Native code (e.g., PagerView setPage) uses requestAnimationFrame
 * which is not available in the node test environment.
 */
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
