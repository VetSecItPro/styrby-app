/**
 * Tests for useAgentConfig hook.
 *
 * WHY: This hook owns the full lifecycle of agent configuration: load from
 * Supabase, form editing, dirty-state detection, save (insert + update paths),
 * blocked-tools management, and reset. Bugs here mean agent settings silently
 * revert or fail to persist.
 *
 * Strategy: mock Supabase + IO helpers + Alert/Keyboard. Drive the hook via
 * renderHook + act and assert state + mock calls.
 *
 * @module components/agent-config/__tests__/use-agent-config
 */

// ============================================================================
// Module mocks
// ============================================================================

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getUser: jest.fn() }, from: jest.fn() },
}));

// WHY: jest.setup.js mocks react-native but omits Keyboard. The hook calls
// Keyboard.dismiss() on save, so we need to add it here.
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn(), prompt: jest.fn() },
  Keyboard: { dismiss: jest.fn() },
  Platform: { OS: 'ios', select: jest.fn((obj: Record<string, unknown>) => obj.ios) },
}));

const mockFetchAgentConfig = jest.fn();
const mockInsertAgentConfig = jest.fn();
const mockUpdateAgentConfig = jest.fn();
const mockBuildRow = jest.fn(() => ({}));
const mockMapRowToState = jest.fn();

jest.mock('../agent-config-io', () => ({
  fetchAgentConfig: (...args: unknown[]) => mockFetchAgentConfig(...args),
  insertAgentConfig: (...args: unknown[]) => mockInsertAgentConfig(...args),
  updateAgentConfig: (...args: unknown[]) => mockUpdateAgentConfig(...args),
  buildRow: (...args: unknown[]) => mockBuildRow(...args),
  mapRowToState: (...args: unknown[]) => mockMapRowToState(...args),
}));

import { Alert, Keyboard } from 'react-native';

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useAgentConfig } from '../use-agent-config';
import { supabase } from '@/lib/supabase';
import type { AgentMeta, AgentType } from '@/types/agent-config';

// ============================================================================
// Test fixtures
// ============================================================================

const claudeMeta: AgentMeta = {
  displayName: 'Claude Code',
  color: '#f97316',
  icon: 'terminal',
  models: ['claude-sonnet-4', 'claude-opus-4'],
};

function mockGetUser(userId = 'user-1') {
  (supabase.auth.getUser as jest.Mock).mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('useAgentConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Initial state
  // --------------------------------------------------------------------------

  it('starts with isLoading true', () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    expect(result.current.isLoading).toBe(true);
  });

  it('uses DEFAULT_CONFIG defaults when no row exists (PGRST116)', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.config.model).toBe('claude-sonnet-4');
    expect(result.current.config.blockedTools).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });

  it('loads config from Supabase row when row exists', async () => {
    mockGetUser();
    const row = {
      id: 'row-1',
      agent_type: 'claude',
      default_model: 'claude-opus-4',
      auto_approve_low_risk: true,
      auto_approve_patterns: ['file_read'],
      blocked_tools: ['bash'],
      max_cost_per_session_usd: 5.0,
      custom_system_prompt: 'Be concise.',
    };
    mockFetchAgentConfig.mockResolvedValue({ data: row, error: null });
    mockMapRowToState.mockReturnValue({
      model: 'claude-opus-4',
      autoApproveReads: true,
      autoApproveWrites: false,
      autoApproveCommands: false,
      autoApproveWeb: false,
      blockedTools: ['bash'],
      maxCostPerSession: '5',
      customSystemPrompt: 'Be concise.',
    });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    expect(result.current.config.model).toBe('claude-opus-4');
    expect(result.current.config.blockedTools).toEqual(['bash']);
    expect(result.current.dirty).toBe(false);
  });

  it('shows an Alert on Supabase fetch error (non-PGRST116)', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Permission denied' },
    });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('Failed to load'),
    );
    expect(result.current.isLoading).toBe(false);
  });

  it('returns early when getUser returns no user', async () => {
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(mockFetchAgentConfig).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // updateField / dirty detection
  // --------------------------------------------------------------------------

  it('updateField mutates config and marks dirty', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    expect(result.current.dirty).toBe(false);

    act(() => {
      result.current.updateField('model', 'claude-opus-4');
    });

    expect(result.current.config.model).toBe('claude-opus-4');
    expect(result.current.dirty).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Blocked tools
  // --------------------------------------------------------------------------

  it('addBlockedTool appends the tool and clears newBlockedTool', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    act(() => result.current.setNewBlockedTool('dangerous_tool'));
    act(() => result.current.addBlockedTool());

    expect(result.current.config.blockedTools).toContain('dangerous_tool');
    expect(result.current.newBlockedTool).toBe('');
  });

  it('addBlockedTool does nothing when newBlockedTool is empty', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});
    act(() => result.current.addBlockedTool());

    expect(result.current.config.blockedTools).toEqual([]);
  });

  it('addBlockedTool shows Alert for duplicate tool', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    act(() => result.current.setNewBlockedTool('bash'));
    act(() => result.current.addBlockedTool());
    act(() => result.current.setNewBlockedTool('bash'));
    act(() => result.current.addBlockedTool());

    expect(Alert.alert).toHaveBeenCalledWith('Already Blocked', expect.stringContaining('bash'));
  });

  it('removeBlockedTool removes the specified tool', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    act(() => result.current.setNewBlockedTool('bash'));
    act(() => result.current.addBlockedTool());
    act(() => result.current.removeBlockedTool('bash'));

    expect(result.current.config.blockedTools).not.toContain('bash');
  });

  // --------------------------------------------------------------------------
  // Save — insert path
  // --------------------------------------------------------------------------

  it('calls insertAgentConfig when configId is null (first save)', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    mockInsertAgentConfig.mockResolvedValue({ data: { id: 'new-row-id' }, error: null });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    await act(async () => {
      await result.current.save();
    });

    expect(mockInsertAgentConfig).toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
    expect(result.current.showSaveSuccess).toBe(true);
  });

  it('calls updateAgentConfig when configId exists (subsequent save)', async () => {
    const row = {
      id: 'row-1',
      agent_type: 'claude',
      default_model: 'claude-sonnet-4',
      auto_approve_low_risk: false,
      auto_approve_patterns: [],
      blocked_tools: [],
      max_cost_per_session_usd: null,
      custom_system_prompt: '',
    };
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: row, error: null });
    mockMapRowToState.mockReturnValue({
      model: 'claude-sonnet-4',
      autoApproveReads: false,
      autoApproveWrites: false,
      autoApproveCommands: false,
      autoApproveWeb: false,
      blockedTools: [],
      maxCostPerSession: '',
      customSystemPrompt: '',
    });
    mockUpdateAgentConfig.mockResolvedValue({ error: null });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    await act(async () => {
      await result.current.save();
    });

    expect(mockUpdateAgentConfig).toHaveBeenCalledWith('row-1', expect.any(Object));
  });

  it('shows Alert when userId is null and save is called', async () => {
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});
    await act(async () => { await result.current.save(); });

    expect(Alert.alert).toHaveBeenCalledWith('Error', expect.stringContaining('signed in'));
  });

  it('hides showSaveSuccess after 2000ms', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    mockInsertAgentConfig.mockResolvedValue({ data: { id: 'new-row-id' }, error: null });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});
    await act(async () => { await result.current.save(); });

    expect(result.current.showSaveSuccess).toBe(true);

    act(() => { jest.advanceTimersByTime(2000); });

    expect(result.current.showSaveSuccess).toBe(false);
  });

  // --------------------------------------------------------------------------
  // discardChanges
  // --------------------------------------------------------------------------

  it('discardChanges reverts form to savedConfig', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    act(() => result.current.updateField('model', 'claude-opus-4'));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.discardChanges());

    expect(result.current.config.model).toBe('claude-sonnet-4');
    expect(result.current.dirty).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Cost validation
  // --------------------------------------------------------------------------

  it('shows Alert for invalid maxCostPerSession (non-numeric)', async () => {
    mockGetUser();
    mockFetchAgentConfig.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const { result } = renderHook(() =>
      useAgentConfig('claude' as AgentType, claudeMeta),
    );

    await act(async () => {});

    act(() => result.current.updateField('maxCostPerSession', 'abc'));

    await act(async () => { await result.current.save(); });

    expect(Alert.alert).toHaveBeenCalledWith('Invalid Cost', expect.any(String));
    expect(mockInsertAgentConfig).not.toHaveBeenCalled();
  });
});
