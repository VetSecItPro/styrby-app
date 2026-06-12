/**
 * useCopyWithClear — copy text to the clipboard with a timed auto-clear.
 *
 * Extracted from the duplicated logic in ChatMessage's CodeBlock and
 * InlineCodeBlock (Cluster A2 split). Both showed a "Copied!" state for 2s and
 * cleared the system clipboard after 30s.
 *
 * WHY the 30s clear (SEC-MOB-001): code blocks can contain secrets (API keys,
 * tokens) a developer copies mid-session. Left in the clipboard, that data is
 * readable by any app that inspects the clipboard on focus (many do). Clearing
 * after 30s bounds the exposure window without disrupting normal paste flows.
 *
 * WHY tracked timers: the setCopied(false) + clipboard-clear callbacks must be
 * cancelled if the component unmounts first, otherwise React warns about state
 * updates on an unmounted component (and the clipboard clear fires spuriously).
 *
 * @module components/chat/useCopyWithClear
 */

import { useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';

/** "Copied!" indicator duration. */
const COPIED_INDICATOR_MS = 2000;
/** Clipboard auto-clear delay (SEC-MOB-001). */
const CLIPBOARD_CLEAR_MS = 30000;

/**
 * @param text - The text to copy when {@link CopyState.handleCopy} runs.
 * @returns `copied` (true for ~2s after a copy) and `handleCopy`.
 */
export function useCopyWithClear(text: string): { copied: boolean; handleCopy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Capture the ref value so cleanup operates on the same array instance even
    // if the ref is reassigned before cleanup runs (React ref-timing guarantee).
    const timers = timerIdsRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    timerIdsRef.current.push(setTimeout(() => setCopied(false), COPIED_INDICATOR_MS));
    timerIdsRef.current.push(setTimeout(() => Clipboard.setStringAsync(''), CLIPBOARD_CLEAR_MS));
  };

  return { copied, handleCopy };
}
