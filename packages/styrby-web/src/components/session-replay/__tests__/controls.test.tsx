/**
 * ReplayControls Component Tests
 *
 * Tests the session replay control bar:
 * - Play/pause button rendering and click handler
 * - Previous/next message buttons with disabled states
 * - Time display formatting (MM:SS and HH:MM:SS)
 * - Speed control dropdown toggle and selection
 * - Message counter display
 * - Progress bar aria attributes
 *
 * WHY: Controls are the primary user interaction surface for session replay.
 * Broken controls mean users cannot navigate through session history.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplayControls } from '../controls';
import type { ReplayControlsProps } from '../types';

// ============================================================================
// Helpers
// ============================================================================

function createDefaultProps(overrides: Partial<ReplayControlsProps> = {}): ReplayControlsProps {
  return {
    isPlaying: false,
    speed: 1,
    currentTimeMs: 0,
    totalDurationMs: 60000, // 1 minute
    currentMessageIndex: 0,
    totalMessages: 10,
    onTogglePlay: vi.fn(),
    onSpeedChange: vi.fn(),
    onSeek: vi.fn(),
    onJumpToMessage: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ReplayControls', () => {
  describe('Play/Pause button', () => {
    it('shows Play label when paused', () => {
      render(<ReplayControls {...createDefaultProps({ isPlaying: false })} />);

      expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    });

    it('shows Pause label when playing', () => {
      render(<ReplayControls {...createDefaultProps({ isPlaying: true })} />);

      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    });

    it('calls onTogglePlay when clicked', () => {
      const onTogglePlay = vi.fn();
      render(<ReplayControls {...createDefaultProps({ onTogglePlay })} />);

      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      expect(onTogglePlay).toHaveBeenCalledOnce();
    });
  });

  describe('Previous/Next message buttons', () => {
    it('disables previous button at index 0', () => {
      render(
        <ReplayControls {...createDefaultProps({ currentMessageIndex: 0 })} />
      );

      const prevButton = screen.getByRole('button', { name: 'Previous message' });
      expect(prevButton).toBeDisabled();
    });

    it('enables previous button when index > 0', () => {
      render(
        <ReplayControls {...createDefaultProps({ currentMessageIndex: 3 })} />
      );

      const prevButton = screen.getByRole('button', { name: 'Previous message' });
      expect(prevButton).not.toBeDisabled();
    });

    it('calls onJumpToMessage with index - 1 for previous', () => {
      const onJumpToMessage = vi.fn();
      render(
        <ReplayControls
          {...createDefaultProps({ currentMessageIndex: 5, onJumpToMessage })}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Previous message' }));
      expect(onJumpToMessage).toHaveBeenCalledWith(4);
    });

    it('disables next button at last message', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentMessageIndex: 9,
            totalMessages: 10,
          })}
        />
      );

      const nextButton = screen.getByRole('button', { name: 'Next message' });
      expect(nextButton).toBeDisabled();
    });

    it('enables next button when not at last message', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentMessageIndex: 3,
            totalMessages: 10,
          })}
        />
      );

      const nextButton = screen.getByRole('button', { name: 'Next message' });
      expect(nextButton).not.toBeDisabled();
    });

    it('calls onJumpToMessage with index + 1 for next', () => {
      const onJumpToMessage = vi.fn();
      render(
        <ReplayControls
          {...createDefaultProps({
            currentMessageIndex: 3,
            totalMessages: 10,
            onJumpToMessage,
          })}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Next message' }));
      expect(onJumpToMessage).toHaveBeenCalledWith(4);
    });

    it('does not call onJumpToMessage when previous is disabled', () => {
      const onJumpToMessage = vi.fn();
      render(
        <ReplayControls
          {...createDefaultProps({ currentMessageIndex: 0, onJumpToMessage })}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Previous message' }));
      expect(onJumpToMessage).not.toHaveBeenCalled();
    });
  });

  describe('Time display', () => {
    it('formats MM:SS for times under an hour', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentTimeMs: 65000, // 1:05
            totalDurationMs: 300000, // 5:00
          })}
        />
      );

      expect(screen.getByText('1:05')).toBeInTheDocument();
      expect(screen.getByText('5:00')).toBeInTheDocument();
    });

    it('formats HH:MM:SS for times over an hour', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentTimeMs: 3661000, // 1:01:01
            totalDurationMs: 7200000, // 2:00:00
          })}
        />
      );

      expect(screen.getByText('1:01:01')).toBeInTheDocument();
      expect(screen.getByText('2:00:00')).toBeInTheDocument();
    });

    it('formats 0:00 for zero time', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentTimeMs: 0,
            totalDurationMs: 60000,
          })}
        />
      );

      expect(screen.getByText('0:00')).toBeInTheDocument();
    });
  });

  describe('Message counter', () => {
    it('displays current message index (1-based) and total', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentMessageIndex: 4,
            totalMessages: 10,
          })}
        />
      );

      // currentMessageIndex 4 => displayed as 5 (1-based)
      expect(screen.getByText(/5\s*\/\s*10/)).toBeInTheDocument();
    });

    it('displays 0 when no message is current (index -1)', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentMessageIndex: -1,
            totalMessages: 10,
          })}
        />
      );

      expect(screen.getByText(/0\s*\/\s*10/)).toBeInTheDocument();
    });
  });

  describe('Speed control', () => {
    it('displays current speed', () => {
      render(
        <ReplayControls {...createDefaultProps({ speed: 2 })} />
      );

      expect(
        screen.getByRole('button', { name: /playback speed.*2x/i })
      ).toBeInTheDocument();
    });

    it('toggles speed dropdown on click', () => {
      render(
        <ReplayControls {...createDefaultProps({ speed: 1 })} />
      );

      const speedButton = screen.getByRole('button', { name: /playback speed/i });

      // Dropdown should not be visible initially
      expect(screen.queryByRole('button', { name: /set speed to 0.5x/i })).not.toBeInTheDocument();

      // Click to open
      fireEvent.click(speedButton);

      // All speed options should be visible
      expect(screen.getByRole('button', { name: /set speed to 0.5x/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set speed to 1x/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set speed to 2x/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set speed to 4x/i })).toBeInTheDocument();
    });

    it('calls onSpeedChange and closes menu on selection', () => {
      const onSpeedChange = vi.fn();
      render(
        <ReplayControls {...createDefaultProps({ speed: 1, onSpeedChange })} />
      );

      // Open dropdown
      fireEvent.click(screen.getByRole('button', { name: /playback speed/i }));

      // Select 4x
      fireEvent.click(screen.getByRole('button', { name: /set speed to 4x/i }));

      expect(onSpeedChange).toHaveBeenCalledWith(4);

      // Dropdown should be closed
      expect(screen.queryByRole('button', { name: /set speed to 0.5x/i })).not.toBeInTheDocument();
    });

    it('has aria-expanded on speed button', () => {
      render(
        <ReplayControls {...createDefaultProps({ speed: 1 })} />
      );

      const speedButton = screen.getByRole('button', { name: /playback speed/i });
      expect(speedButton).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(speedButton);
      expect(speedButton).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('Progress bar accessibility', () => {
    it('has slider role with correct aria attributes', () => {
      render(
        <ReplayControls
          {...createDefaultProps({
            currentTimeMs: 30000,
            totalDurationMs: 60000,
          })}
        />
      );

      const slider = screen.getByRole('slider', { name: /replay progress/i });
      expect(slider).toHaveAttribute('aria-valuemin', '0');
      expect(slider).toHaveAttribute('aria-valuemax', '60000');
      expect(slider).toHaveAttribute('aria-valuenow', '30000');
      expect(slider).toHaveAttribute('aria-valuetext', '0:30 of 1:00');
    });
  });
});
