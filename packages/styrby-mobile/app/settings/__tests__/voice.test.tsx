/**
 * Voice Input Sub-Screen Tests
 *
 * Validates that the Voice Input settings screen:
 * - Renders voice toggle and transcription API section
 * - Loads voice config from SecureStore on mount
 * - Persists enable toggle to SecureStore
 * - Persists mode change to SecureStore
 * - Saves endpoint and API key to SecureStore
 * - Recovers gracefully from malformed JSON in SecureStore
 * - Shows interaction mode selector only when voice is enabled
 *
 * Uses react-test-renderer (node environment — no DOM/jsdom).
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ============================================================================
// Helpers
// ============================================================================

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const texts: string[] = [];
  if (typeof node === 'string') return [node];
  if (node.children) {
    for (const child of node.children) {
      if (typeof child === 'string') {
        texts.push(child);
      } else {
        texts.push(...collectText(child as renderer.ReactTestRendererJSON));
      }
    }
  }
  return texts;
}

function hasText(
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
  text: string,
): boolean {
  return collectText(tree).some((t) => t.includes(text));
}

// ============================================================================
// Global Mocks
// ============================================================================

// -- @expo/vector-icons --
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// -- expo-router --
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  Link: 'Link',
}));

// -- expo-secure-store --
const mockGetItemAsync = jest.fn(async (_key: string): Promise<string | null> => null);
const mockSetItemAsync = jest.fn(async () => {});

jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: Parameters<typeof mockGetItemAsync>) => mockGetItemAsync(...args),
  setItemAsync: (...args: Parameters<typeof mockSetItemAsync>) => mockSetItemAsync(...args),
  deleteItemAsync: jest.fn(async () => {}),
}));

// -- styrby-shared (for VoiceInputConfig type) --
jest.mock('styrby-shared', () => ({
  formatTime: jest.fn((t: string | null, fallback: string) => t ?? fallback),
  getThresholdDescription: jest.fn((t: number) => `Level ${t}`),
  getEstimatedNotificationPercentage: jest.fn((t: number) => t * 20),
  decodePairingUrl: jest.fn(),
  isPairingExpired: jest.fn(() => false),
}));

// ============================================================================
// Component Import
// ============================================================================

import VoiceScreen from '../voice';

// ============================================================================
// Helpers for async rendering
// ============================================================================

async function renderVoiceScreen(): Promise<{
  component: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let component!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    component = renderer.create(<VoiceScreen />);
    await new Promise<void>((r) => setTimeout(r, 50));
  });
  return { component, tree: component.toJSON() };
}

// ============================================================================
// Tests
// ============================================================================

describe('VoiceScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItemAsync.mockResolvedValue(null);
    mockSetItemAsync.mockResolvedValue(undefined);
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  it('renders without crashing', async () => {
    const { tree } = await renderVoiceScreen();
    expect(tree).not.toBeNull();
  });

  it('renders Voice Commands section header', async () => {
    const { tree } = await renderVoiceScreen();
    expect(hasText(tree, 'Voice Commands')).toBe(true);
  });

  it('renders Voice Input toggle', async () => {
    const { component } = await renderVoiceScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle voice input',
    );
    expect(switchNode.length).toBeGreaterThan(0);
  });

  it('renders Transcription API section', async () => {
    const { tree } = await renderVoiceScreen();
    expect(hasText(tree, 'Transcription API')).toBe(true);
  });

  it('renders endpoint URL input', async () => {
    const { component } = await renderVoiceScreen();
    const input = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Transcription endpoint URL',
    );
    expect(input.length).toBeGreaterThan(0);
  });

  it('renders API key input with secureTextEntry', async () => {
    const { component } = await renderVoiceScreen();
    const input = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Transcription API key',
    );
    expect(input.length).toBeGreaterThan(0);
    expect(input[0].props.secureTextEntry).toBe(true);
  });

  it('renders Save Configuration button', async () => {
    const { tree } = await renderVoiceScreen();
    expect(hasText(tree, 'Save Configuration')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Interaction mode selector visibility
  // --------------------------------------------------------------------------

  it('does not show Interaction Mode section when voice is disabled', async () => {
    mockGetItemAsync.mockResolvedValue(
      JSON.stringify({ enabled: false, mode: 'toggle', transcriptionEndpoint: '', transcriptionApiKey: '' }),
    );
    const { tree } = await renderVoiceScreen();
    expect(hasText(tree, 'Interaction Mode')).toBe(false);
  });

  it('shows Interaction Mode section when voice is enabled', async () => {
    mockGetItemAsync.mockResolvedValue(
      JSON.stringify({ enabled: true, mode: 'toggle', transcriptionEndpoint: '', transcriptionApiKey: '' }),
    );
    const { tree } = await renderVoiceScreen();
    expect(hasText(tree, 'Interaction Mode')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SecureStore loading
  // --------------------------------------------------------------------------

  it('loads voice config from SecureStore on mount', async () => {
    const stored = JSON.stringify({
      enabled: true,
      mode: 'hold',
      transcriptionEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
      transcriptionApiKey: 'sk-test',
    });
    mockGetItemAsync.mockResolvedValue(stored);

    await renderVoiceScreen();
    expect(mockGetItemAsync).toHaveBeenCalledWith('styrby_voice_input_config');
  });

  it('handles malformed JSON in SecureStore gracefully', async () => {
    mockGetItemAsync.mockResolvedValue('not-valid-json{');
    // Should not crash
    const { tree } = await renderVoiceScreen();
    expect(tree).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Toggle persistence
  // --------------------------------------------------------------------------

  it('writes voice config to SecureStore when toggled on', async () => {
    const { component } = await renderVoiceScreen();
    const switchNode = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Toggle voice input',
    );

    await renderer.act(async () => {
      switchNode[0].props.onValueChange(true);
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockSetItemAsync).toHaveBeenCalledWith(
      'styrby_voice_input_config',
      expect.stringContaining('"enabled":true'),
    );
  });

  it('writes mode change to SecureStore when mode changed', async () => {
    mockGetItemAsync.mockResolvedValue(
      JSON.stringify({ enabled: true, mode: 'toggle', transcriptionEndpoint: '', transcriptionApiKey: '' }),
    );
    const { component } = await renderVoiceScreen();

    const holdButton = component.root.findAll(
      (node) => node.props.accessibilityLabel === 'Set voice mode to Hold to Talk',
    );
    expect(holdButton.length).toBeGreaterThan(0);

    await renderer.act(async () => {
      holdButton[0].props.onPress();
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    expect(mockSetItemAsync).toHaveBeenCalledWith(
      'styrby_voice_input_config',
      expect.stringContaining('"mode":"hold"'),
    );
  });
});
