/**
 * RPC Handler Manager
 *
 * Manages RPC-style handlers for CLI commands from mobile.
 *
 * WHY: Stub module for Happy Coder's RPC system.
 * Will be replaced with Supabase Edge Function calls or
 * direct Realtime channel messaging.
 *
 * @module api/rpc/RpcHandlerManager
 */

import { logger } from '@/ui/logger';

/**
 * RPC handler function type
 */
export type RpcHandler<T = unknown, R = unknown> = (params: T) => Promise<R> | R;

/**
 * Manages RPC handlers for remote procedure calls.
 *
 * TODO: Decide on RPC pattern
 * Option 1: Supabase Edge Functions (HTTP)
 * Option 2: Supabase Realtime messages (WebSocket)
 * Option 3: Hybrid (Edge Functions for complex ops, Realtime for simple)
 */
export class RpcHandlerManager {
  private handlers: Map<string, RpcHandler> = new Map();

  /**
   * Register an RPC handler.
   *
   * @param method - RPC method name
   * @param handler - Handler function
   */
  register<T = unknown, R = unknown>(method: string, handler: RpcHandler<T, R>): void {
    this.handlers.set(method, handler as RpcHandler);
    logger.debug(`RPC handler registered: ${method}`);
  }

  /**
   * Unregister an RPC handler.
   *
   * @param method - RPC method name
   */
  unregister(method: string): void {
    this.handlers.delete(method);
    logger.debug(`RPC handler unregistered: ${method}`);
  }

  /**
   * Call an RPC handler.
   *
   * @param method - RPC method name
   * @param params - Parameters to pass
   * @returns Handler result
   */
  async call<T = unknown, R = unknown>(method: string, params: T): Promise<R> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`RPC handler not found: ${method}`);
    }
    return handler(params) as Promise<R>;
  }

  /**
   * Check if a handler exists.
   *
   * @param method - RPC method name
   * @returns True if handler exists
   */
  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /**
   * Get all registered method names.
   *
   * @returns Array of method names
   */
  getMethods(): string[] {
    return Array.from(this.handlers.keys());
  }
}

/**
 * Singleton RPC handler manager
 */
export const rpcHandlerManager = new RpcHandlerManager();

/**
 * Default export for compatibility
 */
export default rpcHandlerManager;
