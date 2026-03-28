/**
 * Message Buffer
 *
 * Stub for Happy Coder's Ink message buffer component.
 * Handles buffering and display of streaming agent messages.
 *
 * WHY: We're not using Ink (React for CLI) in our initial build.
 * This stub provides the interface for compatibility while we
 * use simpler console-based output.
 *
 * @module ui/ink/messageBuffer
 */

/**
 * Message in the buffer
 */
export interface BufferedMessage {
  id: string;
  type: 'user' | 'agent' | 'system' | 'error';
  content: string;
  timestamp: number;
}

/**
 * Message buffer for agent output.
 *
 * WHY: Styrby uses console-based output rather than a full TUI framework.
 * Ink (React for CLI) was evaluated but adds significant complexity and
 * bundle weight for minimal gain — the mobile app is the rich UI layer.
 * The MessageBuffer class persists for compatibility with any future Ink
 * rendering paths (e.g., RemoteModeDisplay) that import this type. New
 * TUI features should be built using the Ink components in `src/ui/ink/`
 * rather than extending this buffer.
 */
export class MessageBuffer {
  private messages: BufferedMessage[] = [];
  private maxMessages: number;

  constructor(maxMessages = 100) {
    this.maxMessages = maxMessages;
  }

  /**
   * Add a message to the buffer.
   */
  add(message: Omit<BufferedMessage, 'id' | 'timestamp'>): void {
    const buffered: BufferedMessage = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    this.messages.push(buffered);

    // Trim old messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    // For now, just print to console
    this.printMessage(buffered);
  }

  /**
   * Print a message to console.
   */
  private printMessage(message: BufferedMessage): void {
    const prefix = {
      user: '👤',
      agent: '🤖',
      system: 'ℹ️',
      error: '❌',
    }[message.type];

    // Terminal UI output — intentional console.log for Ink rendering
    console.log(`${prefix} ${message.content}`);
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Get all messages.
   */
  getMessages(): BufferedMessage[] {
    return [...this.messages];
  }

  /**
   * Get message count.
   */
  get length(): number {
    return this.messages.length;
  }
}

/**
 * Create a new message buffer.
 */
export function createMessageBuffer(maxMessages?: number): MessageBuffer {
  return new MessageBuffer(maxMessages);
}

export default MessageBuffer;
