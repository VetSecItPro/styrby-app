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
 * TODO: Replace with proper terminal UI
 * Options:
 * - Keep simple console.log for MVP
 * - Add Ink later for richer TUI
 * - Consider blessed or blessed-contrib
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
