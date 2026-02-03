/**
 * Codex Display
 *
 * Stub for Happy Coder's Ink-based Codex display component.
 *
 * @module ui/ink/CodexDisplay
 */

/**
 * Codex display state
 */
export interface CodexDisplayState {
  status: 'idle' | 'thinking' | 'coding' | 'done' | 'error';
  currentTask?: string;
  output?: string;
  error?: string;
}

/**
 * Codex display component (stub).
 */
export class CodexDisplay {
  private state: CodexDisplayState = { status: 'idle' };

  update(newState: Partial<CodexDisplayState>): void {
    this.state = { ...this.state, ...newState };
    this.render();
  }

  private render(): void {
    const statusIcon = {
      idle: '⏸️',
      thinking: '🤔',
      coding: '💻',
      done: '✅',
      error: '❌',
    }[this.state.status];

    if (this.state.currentTask) {
      console.log(`${statusIcon} ${this.state.currentTask}`);
    }
    if (this.state.output) {
      process.stdout.write(this.state.output);
    }
    if (this.state.error) {
      console.error(`Error: ${this.state.error}`);
    }
  }
}

export function createCodexDisplay(): CodexDisplay {
  return new CodexDisplay();
}

export default CodexDisplay;
