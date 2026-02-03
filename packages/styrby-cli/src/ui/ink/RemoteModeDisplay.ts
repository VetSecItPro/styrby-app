/**
 * Remote Mode Display
 *
 * Stub for Happy Coder's Ink-based remote mode display.
 *
 * @module ui/ink/RemoteModeDisplay
 */

/**
 * Display state for remote mode
 */
export interface RemoteModeDisplayState {
  connectionState: 'connecting' | 'connected' | 'disconnected';
  sessionId?: string;
  agentType?: string;
  lastMessage?: string;
}

/**
 * Remote mode display component (stub).
 *
 * This would be an Ink/React component in Happy Coder.
 * We're using simple console output for now.
 */
export class RemoteModeDisplay {
  private state: RemoteModeDisplayState = {
    connectionState: 'disconnected',
  };

  /**
   * Update display state.
   */
  update(newState: Partial<RemoteModeDisplayState>): void {
    this.state = { ...this.state, ...newState };
    this.render();
  }

  /**
   * Render current state to console.
   */
  private render(): void {
    // Simple console-based rendering
    const statusIcon = {
      connecting: '🔄',
      connected: '🟢',
      disconnected: '🔴',
    }[this.state.connectionState];

    console.clear();
    console.log('━'.repeat(50));
    console.log(`${statusIcon} Styrby Remote Mode`);
    console.log('━'.repeat(50));

    if (this.state.sessionId) {
      console.log(`Session: ${this.state.sessionId.slice(0, 8)}...`);
    }
    if (this.state.agentType) {
      console.log(`Agent: ${this.state.agentType}`);
    }
    if (this.state.lastMessage) {
      console.log(`\nLast: ${this.state.lastMessage}`);
    }

    console.log('\n[Ctrl+C to exit]');
  }

  /**
   * Start the display.
   */
  start(): void {
    this.render();
  }

  /**
   * Stop the display.
   */
  stop(): void {
    console.clear();
  }
}

export function createRemoteModeDisplay(): RemoteModeDisplay {
  return new RemoteModeDisplay();
}

export default RemoteModeDisplay;
