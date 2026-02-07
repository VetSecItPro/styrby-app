/**
 * ReplayPlayer Component Tests
 *
 * Tests the main session replay player component:
 * - Renders messages with correct type-based styling
 * - Shows empty state for no messages
 * - Renders header with message count
 * - Renders exit button when callback provided
 * - Skips permission_response messages
 * - Integrates with ReplayControls
 *
 * WHY: The player is the core UI for reviewing past sessions.
 * Rendering bugs could show messages with wrong styling, wrong order,
 * or leak messages that should be hidden (permission_response).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReplayPlayer } from '../player';
import type { ReplayMessage } from '../types';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mock the useReplayState hook to control playback state in tests.
 */
vi.mock('../use-replay-state', () => ({
  useReplayState: vi.fn(({ messages }: { messages: ReplayMessage[] }) => ({
    playbackState: 'stopped' as const,
    isPlaying: false,
    speed: 1 as const,
    currentTimeMs: 0,
    totalDurationMs: 10000,
    currentMessageIndex: messages.length - 1,
    visibleMessages: messages,
    play: vi.fn(),
    pause: vi.fn(),
    togglePlay: vi.fn(),
    stop: vi.fn(),
    setSpeed: vi.fn(),
    seekToTime: vi.fn(),
    jumpToMessage: vi.fn(),
  })),
}));

/**
 * Mock clipboard API for copy code buttons.
 */
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

/**
 * Mock scrollIntoView - not available in jsdom.
 * WHY: The ReplayPlayer uses scrollIntoView for auto-scrolling to the
 * current message during playback. jsdom doesn't implement it.
 */
Element.prototype.scrollIntoView = vi.fn();

// ============================================================================
// Helpers
// ============================================================================

const BASE_TIME = new Date('2025-01-01T00:00:00Z').getTime();

function createMessage(
  id: string,
  type: ReplayMessage['message_type'],
  content: string,
  offsetMs = 0,
  extra: Partial<ReplayMessage> = {}
): ReplayMessage {
  return {
    id,
    session_id: 'session-001',
    sequence_number: parseInt(id.replace('msg-', ''), 10),
    message_type: type,
    content_encrypted: content,
    risk_level: null,
    permission_granted: null,
    tool_name: null,
    duration_ms: null,
    metadata: null,
    created_at: new Date(BASE_TIME + offsetMs).toISOString(),
    ...extra,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ReplayPlayer', () => {
  describe('Empty state', () => {
    it('renders empty state when no messages', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[]}
        />
      );

      expect(screen.getByText('No messages to replay')).toBeInTheDocument();
      expect(
        screen.getByText(/no recorded messages/i)
      ).toBeInTheDocument();
    });
  });

  describe('Header', () => {
    it('shows Session Replay label', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'user_prompt', 'Hello'),
          ]}
        />
      );

      expect(screen.getByText('Session Replay')).toBeInTheDocument();
    });

    it('shows message count', () => {
      const messages = [
        createMessage('msg-1', 'user_prompt', 'Hello', 0),
        createMessage('msg-2', 'agent_response', 'Hi there', 1000),
        createMessage('msg-3', 'tool_use', 'Running tool', 2000),
      ];

      render(
        <ReplayPlayer sessionId="session-001" messages={messages} />
      );

      expect(screen.getByText('3 messages')).toBeInTheDocument();
    });
  });

  describe('Exit button', () => {
    it('renders exit button when onExitReplay is provided', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[createMessage('msg-1', 'user_prompt', 'Hello')]}
          onExitReplay={vi.fn()}
        />
      );

      expect(
        screen.getByRole('button', { name: /exit replay/i })
      ).toBeInTheDocument();
    });

    it('does not render exit button when onExitReplay is omitted', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[createMessage('msg-1', 'user_prompt', 'Hello')]}
        />
      );

      expect(
        screen.queryByRole('button', { name: /exit replay/i })
      ).not.toBeInTheDocument();
    });

    it('calls onExitReplay when clicked', () => {
      const onExitReplay = vi.fn();
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[createMessage('msg-1', 'user_prompt', 'Hello')]}
          onExitReplay={onExitReplay}
        />
      );

      screen.getByRole('button', { name: /exit replay/i }).click();
      expect(onExitReplay).toHaveBeenCalledOnce();
    });
  });

  describe('Message rendering', () => {
    it('renders user prompts with sender label "You"', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'user_prompt', 'Write a function'),
          ]}
        />
      );

      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('Write a function')).toBeInTheDocument();
    });

    it('renders agent responses with sender label "Agent"', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'agent_response', 'Here is the function'),
          ]}
        />
      );

      expect(screen.getByText('Agent')).toBeInTheDocument();
      expect(screen.getByText('Here is the function')).toBeInTheDocument();
    });

    it('renders tool_use messages with sender label "Tool" and tool name', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'tool_use', 'Running file search', 0, {
              tool_name: 'search_files',
            }),
          ]}
        />
      );

      expect(screen.getByText('Tool')).toBeInTheDocument();
      expect(screen.getByText('search_files')).toBeInTheDocument();
    });

    it('renders error messages with sender label "Error"', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'error', 'Connection timeout'),
          ]}
        />
      );

      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Connection timeout')).toBeInTheDocument();
    });

    it('renders system messages with sender label "System"', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'system', 'Session started'),
          ]}
        />
      );

      expect(screen.getByText('System')).toBeInTheDocument();
    });

    it('skips permission_response messages', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'user_prompt', 'Hello'),
            createMessage('msg-2', 'permission_response', 'granted', 1000),
            createMessage('msg-3', 'agent_response', 'Hi there', 2000),
          ]}
        />
      );

      expect(screen.getByText('Hello')).toBeInTheDocument();
      expect(screen.getByText('Hi there')).toBeInTheDocument();
      // The permission_response content should not be rendered
      expect(screen.queryByText('granted')).not.toBeInTheDocument();
    });

    it('shows duration_ms when present', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'agent_response', 'Response text', 0, {
              duration_ms: 2500,
            }),
          ]}
        />
      );

      expect(screen.getByText('2.5s')).toBeInTheDocument();
    });
  });

  describe('Code block rendering', () => {
    it('renders code blocks with language label and copy button', () => {
      const content = 'Here is some code:\n```typescript\nconst x = 1;\n```';

      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'agent_response', content),
          ]}
        />
      );

      expect(screen.getByText('typescript')).toBeInTheDocument();
      expect(screen.getByText('const x = 1;')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /copy code/i })
      ).toBeInTheDocument();
    });
  });

  describe('Message area accessibility', () => {
    it('has log role on message area', () => {
      render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[createMessage('msg-1', 'user_prompt', 'Hello')]}
        />
      );

      expect(
        screen.getByRole('log', { name: /session replay messages/i })
      ).toBeInTheDocument();
    });

    it('sets data-message-id on each message', () => {
      const { container } = render(
        <ReplayPlayer
          sessionId="session-001"
          messages={[
            createMessage('msg-1', 'user_prompt', 'Hello'),
            createMessage('msg-2', 'agent_response', 'Hi', 1000),
          ]}
        />
      );

      const messageElements = container.querySelectorAll('[data-message-id]');
      expect(messageElements).toHaveLength(2);
      expect(messageElements[0]).toHaveAttribute('data-message-id', 'msg-1');
      expect(messageElements[1]).toHaveAttribute('data-message-id', 'msg-2');
    });
  });
});
