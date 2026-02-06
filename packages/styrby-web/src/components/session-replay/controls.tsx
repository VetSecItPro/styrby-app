'use client';

/**
 * Session Replay Controls Component
 *
 * Provides playback controls for the session replay player:
 * - Play/Pause button
 * - Speed control (0.5x, 1x, 2x, 4x)
 * - Progress bar with time display
 * - Jump to specific message (click on timeline)
 */

import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { PlaybackSpeed, ReplayControlsProps } from './types';

/* ──────────────────────────── Icons ──────────────────────────── */

/**
 * Play icon for the play button.
 */
function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/**
 * Pause icon for the pause button.
 */
function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

/**
 * Skip forward icon for jumping to next message.
 */
function SkipForwardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}

/**
 * Skip backward icon for jumping to previous message.
 */
function SkipBackwardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 19l-7-7 7-7"
      />
    </svg>
  );
}

/* ──────────────────────────── Helpers ──────────────────────────── */

/**
 * Formats milliseconds to a human-readable time string (MM:SS or HH:MM:SS).
 *
 * @param ms - Time in milliseconds
 * @returns Formatted time string
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Available playback speed options.
 */
const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4];

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders the replay control bar with playback controls.
 *
 * WHY: Users need intuitive controls to navigate through session replays.
 * The interface mimics familiar video player controls for easy adoption.
 *
 * @param props - ReplayControls configuration
 */
export function ReplayControls({
  isPlaying,
  speed,
  currentTimeMs,
  totalDurationMs,
  currentMessageIndex,
  totalMessages,
  onTogglePlay,
  onSpeedChange,
  onSeek,
  onJumpToMessage,
}: ReplayControlsProps) {
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  /**
   * Calculate progress percentage (0-100).
   */
  const progressPercent =
    totalDurationMs > 0 ? (currentTimeMs / totalDurationMs) * 100 : 0;

  /**
   * Handle click on the progress bar to seek.
   */
  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!progressBarRef.current || totalDurationMs === 0) return;

      const rect = progressBarRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = clickX / rect.width;
      const newTimeMs = percent * totalDurationMs;

      onSeek(Math.max(0, Math.min(newTimeMs, totalDurationMs)));
    },
    [totalDurationMs, onSeek]
  );

  /**
   * Handle mouse down for dragging the progress bar.
   */
  const handleMouseDown = useCallback(() => {
    setIsDragging(true);
  }, []);

  /**
   * Handle mouse move for dragging the progress bar.
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !progressBarRef.current || totalDurationMs === 0) return;

      const rect = progressBarRef.current.getBoundingClientRect();
      const moveX = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, moveX / rect.width));
      const newTimeMs = percent * totalDurationMs;

      onSeek(newTimeMs);
    },
    [isDragging, totalDurationMs, onSeek]
  );

  /**
   * Handle mouse up to stop dragging.
   */
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Add global mouse event listeners when dragging
  React.useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  /**
   * Jump to the previous message.
   */
  const handlePrevMessage = useCallback(() => {
    if (currentMessageIndex > 0) {
      onJumpToMessage(currentMessageIndex - 1);
    }
  }, [currentMessageIndex, onJumpToMessage]);

  /**
   * Jump to the next message.
   */
  const handleNextMessage = useCallback(() => {
    if (currentMessageIndex < totalMessages - 1) {
      onJumpToMessage(currentMessageIndex + 1);
    }
  }, [currentMessageIndex, totalMessages, onJumpToMessage]);

  /**
   * Handle speed selection from dropdown.
   */
  const handleSpeedSelect = useCallback(
    (newSpeed: PlaybackSpeed) => {
      onSpeedChange(newSpeed);
      setShowSpeedMenu(false);
    },
    [onSpeedChange]
  );

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 backdrop-blur-sm px-4 py-3">
      {/* Progress bar */}
      <div className="mb-3">
        <div
          ref={progressBarRef}
          className="relative h-2 bg-zinc-700 rounded-full cursor-pointer group"
          onClick={handleProgressClick}
          onMouseDown={handleMouseDown}
          role="slider"
          aria-label="Replay progress"
          aria-valuemin={0}
          aria-valuemax={totalDurationMs}
          aria-valuenow={currentTimeMs}
          aria-valuetext={`${formatTime(currentTimeMs)} of ${formatTime(totalDurationMs)}`}
          tabIndex={0}
        >
          {/* Progress fill */}
          <div
            className="absolute inset-y-0 left-0 bg-orange-500 rounded-full transition-all"
            style={{ width: `${progressPercent}%` }}
          />

          {/* Scrubber handle */}
          <div
            className={cn(
              'absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg transition-transform',
              'opacity-0 group-hover:opacity-100',
              isDragging && 'opacity-100 scale-110'
            )}
            style={{ left: `calc(${progressPercent}% - 8px)` }}
          />
        </div>
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between">
        {/* Left: Time display */}
        <div className="flex items-center gap-2 text-sm text-zinc-400 min-w-[120px]">
          <span className="font-mono">{formatTime(currentTimeMs)}</span>
          <span>/</span>
          <span className="font-mono">{formatTime(totalDurationMs)}</span>
        </div>

        {/* Center: Playback controls */}
        <div className="flex items-center gap-2">
          {/* Previous message */}
          <button
            onClick={handlePrevMessage}
            disabled={currentMessageIndex <= 0}
            className={cn(
              'p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors',
              currentMessageIndex <= 0 && 'opacity-50 cursor-not-allowed'
            )}
            aria-label="Previous message"
          >
            <SkipBackwardIcon className="h-5 w-5" />
          </button>

          {/* Play/Pause */}
          <button
            onClick={onTogglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-500 text-white hover:bg-orange-600 transition-colors"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <PauseIcon className="h-5 w-5" />
            ) : (
              <PlayIcon className="h-5 w-5 ml-0.5" />
            )}
          </button>

          {/* Next message */}
          <button
            onClick={handleNextMessage}
            disabled={currentMessageIndex >= totalMessages - 1}
            className={cn(
              'p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors',
              currentMessageIndex >= totalMessages - 1 &&
                'opacity-50 cursor-not-allowed'
            )}
            aria-label="Next message"
          >
            <SkipForwardIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Right: Speed control and message counter */}
        <div className="flex items-center gap-4 min-w-[120px] justify-end">
          {/* Message counter */}
          <span className="text-sm text-zinc-500">
            {currentMessageIndex >= 0 ? currentMessageIndex + 1 : 0} /{' '}
            {totalMessages}
          </span>

          {/* Speed control */}
          <div className="relative">
            <button
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
              aria-label={`Playback speed: ${speed}x`}
              aria-expanded={showSpeedMenu}
              aria-haspopup="true"
            >
              <span>{speed}x</span>
              <svg
                className={cn(
                  'h-4 w-4 transition-transform',
                  showSpeedMenu && 'rotate-180'
                )}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {/* Speed dropdown menu */}
            {showSpeedMenu && (
              <div className="absolute bottom-full right-0 mb-1 py-1 bg-zinc-800 rounded-lg border border-zinc-700 shadow-xl z-10">
                {SPEED_OPTIONS.map((speedOption) => (
                  <button
                    key={speedOption}
                    onClick={() => handleSpeedSelect(speedOption)}
                    className={cn(
                      'w-full px-4 py-1.5 text-sm text-left hover:bg-zinc-700 transition-colors',
                      speed === speedOption
                        ? 'text-orange-500 font-medium'
                        : 'text-zinc-300'
                    )}
                    aria-label={`Set speed to ${speedOption}x`}
                  >
                    {speedOption}x
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// React import for useEffect hook
import React from 'react';
