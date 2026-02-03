/**
 * Gemini Display
 *
 * Stub for Happy Coder's Ink-based Gemini display component.
 *
 * @module ui/ink/GeminiDisplay
 */

/**
 * Gemini display state
 */
export interface GeminiDisplayState {
  status: 'idle' | 'thinking' | 'coding' | 'done' | 'error';
  model?: string;
  currentTask?: string;
  output?: string;
  error?: string;
}

/**
 * Gemini display component (stub).
 */
export class GeminiDisplay {
  private state: GeminiDisplayState = { status: 'idle' };

  update(newState: Partial<GeminiDisplayState>): void {
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

    if (this.state.model) {
      console.log(`🔷 Gemini (${this.state.model})`);
    }
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

export function createGeminiDisplay(): GeminiDisplay {
  return new GeminiDisplay();
}

export default GeminiDisplay;
