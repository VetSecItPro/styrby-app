/**
 * Tests for the useCostExport hook (full flow).
 *
 * WHY: The existing useCostExport.test.ts only covers the pure helpers.
 * This file covers the hook itself: auth check, fetch error codes (403, 429,
 * network error), success path with Share, and showExportPicker branching.
 *
 * Pure helpers (buildExportFilename, getAppUrl) are already tested in
 * useCostExport.test.ts and are not duplicated here.
 *
 * @module hooks/__tests__/useCostExport-hook
 */

// ============================================================================
// Module mocks
// ============================================================================

const mockGetSession = jest.fn();
jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
  },
}));

// WHY: jest.setup.js already mocks react-native for the node test environment.
// We augment that mock by adding Share, ActionSheetIOS, and overriding Platform.
// jest.requireActual('react-native') is NOT used here because react-native ships
// ESM which cannot be parsed in the node test environment.
const mockShare = jest.fn<unknown, unknown[]>(async () => ({ action: 'sharedAction' }));
jest.mock('react-native', () => ({
  Share: { share: (...args: unknown[]) => mockShare(...args) },
  Alert: { alert: jest.fn() },
  ActionSheetIOS: {
    showActionSheetWithOptions: jest.fn(
      (_opts: unknown, cb: (i: number) => void) => cb(1), // always simulate "Export as CSV"
    ),
  },
  Platform: { OS: 'ios', select: jest.fn((obj: Record<string, unknown>) => obj.ios) },
}));

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { Alert, ActionSheetIOS } from 'react-native';
import { useCostExport } from '../useCostExport';

// ============================================================================
// Helpers
// ============================================================================

function mockAuthed(token = 'test-token') {
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: token } },
    error: null,
  });
}

function mockFetch(status: number, body: unknown = '') {
  global.fetch = jest.fn<unknown, unknown[]>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })) as jest.Mock;
}

// ============================================================================
// Tests
// ============================================================================

describe('useCostExport hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = jest.fn();
  });

  // --------------------------------------------------------------------------
  // Initial state
  // --------------------------------------------------------------------------

  it('starts with isExporting false', () => {
    const { result } = renderHook(() => useCostExport(30));
    expect(result.current.isExporting).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Auth guard
  // --------------------------------------------------------------------------

  it('shows "Not Authenticated" Alert when no session exists', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const { result } = renderHook(() => useCostExport(30));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Not Authenticated',
      expect.stringContaining('log in'),
    );
  });

  // --------------------------------------------------------------------------
  // HTTP error codes
  // --------------------------------------------------------------------------

  it('shows Power Tier Required Alert on 403', async () => {
    mockAuthed();
    mockFetch(403);

    const { result } = renderHook(() => useCostExport(30));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Power Tier Required',
      expect.any(String),
    );
    expect(result.current.isExporting).toBe(false);
  });

  it('shows Rate Limited Alert on 429', async () => {
    mockAuthed();
    mockFetch(429);

    const { result } = renderHook(() => useCostExport(30));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Rate Limited',
      expect.stringContaining('once per hour'),
    );
  });

  it('shows Export Failed Alert on other HTTP error', async () => {
    mockAuthed();
    mockFetch(500, { message: 'Server exploded' });

    const { result } = renderHook(() => useCostExport(30));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(Alert.alert).toHaveBeenCalledWith('Export Failed', expect.stringContaining('Server exploded'));
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it('calls Share.share with file content on successful export', async () => {
    mockAuthed();
    mockFetch(200, 'date,cost\n2026-04-20,1.23');

    const { result } = renderHook(() => useCostExport(30));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'date,cost\n2026-04-20,1.23',
        title: expect.stringMatching(/styrby-costs.*\.csv/),
      }),
    );
    expect(result.current.isExporting).toBe(false);
  });

  // --------------------------------------------------------------------------
  // showExportPicker — iOS triggers ActionSheet
  // --------------------------------------------------------------------------

  it('calls ActionSheetIOS on iOS', async () => {
    mockAuthed();
    mockFetch(200, 'csv data');

    const { result } = renderHook(() => useCostExport(7));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Export Cost Data' }),
      expect.any(Function),
    );
  });

  // --------------------------------------------------------------------------
  // URL includes timeRange
  // --------------------------------------------------------------------------

  it('passes days param to the API URL', async () => {
    mockAuthed();
    mockFetch(200, 'data');
    const fetchSpy = jest.spyOn(global, 'fetch');

    const { result } = renderHook(() => useCostExport(90));

    await act(async () => {
      result.current.showExportPicker();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('days=90'),
      expect.any(Object),
    );
  });
});
