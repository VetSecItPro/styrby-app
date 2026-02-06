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
// expo-linking
// ============================================================================

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => {}),
  createURL: jest.fn((path) => `styrby://${path}`),
}));

// ============================================================================
// react-native (partial mock for Platform)
// ============================================================================

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: jest.fn((obj) => obj.ios) },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    currentState: 'active',
  },
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
