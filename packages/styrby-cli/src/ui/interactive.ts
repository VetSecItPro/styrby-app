/**
 * Interactive Menu System
 *
 * Provides keyboard-navigable menus for the CLI.
 * Uses raw mode readline for arrow key navigation.
 *
 * @module ui/interactive
 */

import * as readline from 'node:readline';
import { clearScreen } from './welcome';

// ============================================================================
// Types
// ============================================================================

/**
 * Menu option
 */
export interface MenuOption<T = string> {
  /** Unique identifier for this option */
  value: T;
  /** Display label */
  label: string;
  /** Optional hint text (shown to the right) */
  hint?: string;
  /** Whether this option is disabled */
  disabled?: boolean;
}

/**
 * Menu configuration
 */
export interface MenuConfig<T = string> {
  /** Menu options */
  options: MenuOption<T>[];
  /** Initial selected index */
  initialIndex?: number;
  /** Function to render the full screen (called on each update) */
  render: (selectedIndex: number) => void;
  /** Whether to clear screen on each render */
  clearOnRender?: boolean;
}

/**
 * Menu result
 */
export interface MenuResult<T = string> {
  /** Selected value */
  value: T;
  /** Selected index */
  index: number;
  /** Whether selection was cancelled (Escape/q) */
  cancelled: boolean;
}

// ============================================================================
// Keyboard Input
// ============================================================================

/**
 * Key codes for navigation
 */
const KEY = {
  UP: '\x1B[A',
  DOWN: '\x1B[B',
  ENTER: '\r',
  ESCAPE: '\x1B',
  CTRL_C: '\x03',
  Q: 'q',
  J: 'j',  // vim down
  K: 'k',  // vim up
} as const;

/**
 * Enable raw mode for keyboard input.
 *
 * @returns Cleanup function to restore normal mode
 */
function enableRawMode(): () => void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  return () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };
}

// ============================================================================
// Interactive Menu
// ============================================================================

/**
 * Display an interactive menu and wait for selection.
 *
 * Supports:
 * - Arrow keys (↑/↓) for navigation
 * - Vim keys (j/k) for navigation
 * - Enter to select
 * - Escape or q to cancel
 * - Ctrl+C to exit
 *
 * @param config - Menu configuration
 * @returns Promise resolving to selected option
 *
 * @example
 * const result = await showMenu({
 *   options: [
 *     { value: 'start', label: 'Start session' },
 *     { value: 'settings', label: 'Settings' },
 *     { value: 'quit', label: 'Quit' },
 *   ],
 *   render: (index) => {
 *     displayWelcome();
 *     displayMenu(options, index);
 *   },
 * });
 */
export function showMenu<T = string>(config: MenuConfig<T>): Promise<MenuResult<T>> {
  return new Promise((resolve) => {
    const { options, initialIndex = 0, render, clearOnRender = true } = config;

    let selectedIndex = initialIndex;
    let inputBuffer = '';

    // Find first non-disabled option
    while (selectedIndex < options.length && options[selectedIndex].disabled) {
      selectedIndex++;
    }
    if (selectedIndex >= options.length) {
      selectedIndex = options.findIndex((o) => !o.disabled);
      if (selectedIndex === -1) selectedIndex = 0;
    }

    // Initial render
    if (clearOnRender) clearScreen();
    render(selectedIndex);

    // Enable raw mode
    const cleanup = enableRawMode();

    // Handle keypress
    const onData = (data: Buffer): void => {
      const key = data.toString();

      // Handle escape sequences (arrow keys)
      inputBuffer += key;

      // Check for arrow keys
      if (inputBuffer.endsWith(KEY.UP) || key === KEY.K) {
        // Move up, skip disabled
        let newIndex = selectedIndex - 1;
        while (newIndex >= 0 && options[newIndex].disabled) {
          newIndex--;
        }
        if (newIndex >= 0) {
          selectedIndex = newIndex;
          if (clearOnRender) clearScreen();
          render(selectedIndex);
        }
        inputBuffer = '';
        return;
      }

      if (inputBuffer.endsWith(KEY.DOWN) || key === KEY.J) {
        // Move down, skip disabled
        let newIndex = selectedIndex + 1;
        while (newIndex < options.length && options[newIndex].disabled) {
          newIndex++;
        }
        if (newIndex < options.length) {
          selectedIndex = newIndex;
          if (clearOnRender) clearScreen();
          render(selectedIndex);
        }
        inputBuffer = '';
        return;
      }

      // Clear buffer if it's getting long (not an escape sequence)
      if (inputBuffer.length > 10) {
        inputBuffer = '';
      }

      // Handle single character keys
      if (key === KEY.ENTER) {
        cleanup();
        process.stdin.removeListener('data', onData);
        resolve({
          value: options[selectedIndex].value,
          index: selectedIndex,
          cancelled: false,
        });
        return;
      }

      if (key === KEY.ESCAPE || key === KEY.Q) {
        cleanup();
        process.stdin.removeListener('data', onData);
        resolve({
          value: options[selectedIndex].value,
          index: selectedIndex,
          cancelled: true,
        });
        return;
      }

      if (key === KEY.CTRL_C) {
        cleanup();
        process.stdin.removeListener('data', onData);
        console.log('');
        process.exit(0);
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Wait for any key press.
 *
 * @param message - Optional message to display
 * @returns Promise that resolves when a key is pressed
 */
export function waitForKeyPress(message?: string): Promise<void> {
  return new Promise((resolve) => {
    if (message) {
      console.log(message);
    }

    const cleanup = enableRawMode();

    const onData = (): void => {
      cleanup();
      process.stdin.removeListener('data', onData);
      resolve();
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Show a confirmation prompt (y/n).
 *
 * @param message - Confirmation message
 * @param defaultValue - Default value if Enter is pressed
 * @returns Promise resolving to boolean
 */
export function confirm(message: string, defaultValue: boolean = false): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultValue ? '[Y/n]' : '[y/N]';
    process.stdout.write(`  ${message} ${hint} `);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('', (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') {
        resolve(defaultValue);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Show a text input prompt.
 *
 * @param message - Prompt message
 * @param defaultValue - Default value
 * @returns Promise resolving to entered text
 */
export function prompt(message: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultValue ? ` (${defaultValue})` : '';
    process.stdout.write(`  ${message}${hint}: `);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Default export for module
 */
export default {
  showMenu,
  waitForKeyPress,
  confirm,
  prompt,
};
