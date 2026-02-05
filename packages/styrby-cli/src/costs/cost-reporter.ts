/**
 * Cost Reporter
 *
 * Reports extracted cost data to Supabase and broadcasts updates to connected
 * mobile devices via the relay system. Handles batching, retry logic, and
 * offline queuing.
 *
 * ## Data Flow
 *
 * ```
 * CostExtractor → CostReporter → Supabase (cost_records table)
 *                              → Relay (mobile broadcast)
 * ```
 *
 * ## Batching Strategy
 *
 * To avoid excessive writes:
 * - Costs are batched and reported every 30 seconds (configurable)
 * - On session end, any remaining costs are flushed immediately
 * - Critical budget alerts trigger immediate reporting
 *
 * @module costs/cost-reporter
 */

import { EventEmitter } from 'node:events';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RelayClient, CostUpdateMessage } from 'styrby-shared';
import type { AgentType } from '@/auth/agent-credentials';
import type { CostRecord, SessionCostSummary } from './cost-extractor.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the cost reporter
 */
export interface CostReporterConfig {
  /** Supabase client for database operations */
  supabase: SupabaseClient;
  /** Relay client for mobile broadcasts (optional) */
  relay?: RelayClient;
  /** User ID for the cost records */
  userId: string;
  /** Session ID */
  sessionId: string;
  /** Device/machine ID */
  machineId: string;
  /** Agent type */
  agentType: AgentType;
  /** Batch interval in milliseconds (default: 30000) */
  batchIntervalMs?: number;
  /** Maximum records per batch (default: 50) */
  maxBatchSize?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Cost record ready for Supabase insertion
 */
interface SupabaseCostRecord {
  user_id: string;
  session_id: string;
  agent_type: AgentType;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  price_per_input_token: number | null;
  price_per_output_token: number | null;
  recorded_at: string;
  record_date: string;
}

/**
 * Events emitted by the cost reporter
 */
export interface CostReporterEvents {
  /** Batch was successfully reported */
  reported: { count: number; totalCostUsd: number };
  /** Error during reporting */
  error: { message: string; error?: Error };
  /** Mobile was notified of cost update */
  mobileBroadcast: { costUsd: number; sessionTotalUsd: number };
}

// ============================================================================
// Cost Reporter Class
// ============================================================================

/**
 * Cost Reporter
 *
 * Manages the reporting of cost data to Supabase and connected mobile devices.
 * Batches writes for efficiency and handles network failures gracefully.
 */
export class CostReporter extends EventEmitter {
  private config: Required<Omit<CostReporterConfig, 'relay'>> & { relay?: RelayClient };
  private pendingRecords: CostRecord[] = [];
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private sessionTotalCostUsd = 0;
  private reportedRecordCount = 0;
  private isStarted = false;

  constructor(config: CostReporterConfig) {
    super();
    this.config = {
      batchIntervalMs: 30000, // 30 seconds default
      maxBatchSize: 50,
      debug: false,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the periodic reporting timer.
   */
  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.batchTimer = setInterval(() => {
      this.flush().catch((error) => {
        this.emit('error', {
          message: 'Batch flush failed',
          error: error instanceof Error ? error : undefined,
        });
      });
    }, this.config.batchIntervalMs);

    this.log('Reporter started', { batchIntervalMs: this.config.batchIntervalMs });
  }

  /**
   * Stop the periodic reporting timer and flush remaining records.
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.isStarted = false;

    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }

    // Flush any remaining records
    await this.flush();

    this.log('Reporter stopped', {
      totalReported: this.reportedRecordCount,
      totalCostUsd: this.sessionTotalCostUsd,
    });
  }

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  /**
   * Add a cost record to the pending batch.
   *
   * @param record - Cost record to report
   */
  addRecord(record: CostRecord): void {
    this.pendingRecords.push(record);
    this.sessionTotalCostUsd += record.costUsd;

    this.log('Record added', {
      costUsd: record.costUsd,
      pendingCount: this.pendingRecords.length,
    });

    // Auto-flush if batch is full
    if (this.pendingRecords.length >= this.config.maxBatchSize) {
      this.flush().catch((error) => {
        this.emit('error', {
          message: 'Batch flush failed',
          error: error instanceof Error ? error : undefined,
        });
      });
    }
  }

  /**
   * Add multiple cost records at once.
   *
   * @param records - Array of cost records
   */
  addRecords(records: CostRecord[]): void {
    for (const record of records) {
      this.addRecord(record);
    }
  }

  // --------------------------------------------------------------------------
  // Reporting
  // --------------------------------------------------------------------------

  /**
   * Flush pending records to Supabase.
   *
   * @returns Number of records successfully reported
   */
  async flush(): Promise<number> {
    if (this.pendingRecords.length === 0) {
      return 0;
    }

    const recordsToReport = this.pendingRecords.splice(0, this.config.maxBatchSize);
    const batchCostUsd = recordsToReport.reduce((sum, r) => sum + r.costUsd, 0);

    try {
      // Convert to Supabase format
      const supabaseRecords = recordsToReport.map((r) => this.toSupabaseRecord(r));

      // Insert into cost_records table
      const { error } = await this.config.supabase
        .from('cost_records')
        .insert(supabaseRecords);

      if (error) {
        // Put records back on retry failure
        this.pendingRecords.unshift(...recordsToReport);
        throw new Error(`Supabase insert failed: ${error.message}`);
      }

      this.reportedRecordCount += recordsToReport.length;

      this.emit('reported', {
        count: recordsToReport.length,
        totalCostUsd: batchCostUsd,
      });

      this.log('Batch reported', {
        count: recordsToReport.length,
        batchCostUsd,
        sessionTotalUsd: this.sessionTotalCostUsd,
      });

      // Broadcast to mobile if relay is connected
      await this.broadcastToMobile(batchCostUsd);

      return recordsToReport.length;
    } catch (error) {
      this.log('Flush failed', { error });
      this.emit('error', {
        message: 'Failed to flush cost records',
        error: error instanceof Error ? error : undefined,
      });
      return 0;
    }
  }

  /**
   * Immediately report a single cost record (for critical updates).
   *
   * @param record - Cost record to report immediately
   */
  async reportImmediate(record: CostRecord): Promise<boolean> {
    this.sessionTotalCostUsd += record.costUsd;

    try {
      const supabaseRecord = this.toSupabaseRecord(record);

      const { error } = await this.config.supabase
        .from('cost_records')
        .insert(supabaseRecord);

      if (error) {
        throw new Error(`Supabase insert failed: ${error.message}`);
      }

      this.reportedRecordCount++;

      this.emit('reported', {
        count: 1,
        totalCostUsd: record.costUsd,
      });

      // Broadcast to mobile
      await this.broadcastToMobile(record.costUsd);

      this.log('Immediate report', { costUsd: record.costUsd });

      return true;
    } catch (error) {
      // On failure, add to pending batch for retry
      this.pendingRecords.push(record);
      this.emit('error', {
        message: 'Immediate report failed, queued for retry',
        error: error instanceof Error ? error : undefined,
      });
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Mobile Broadcast
  // --------------------------------------------------------------------------

  /**
   * Broadcast cost update to connected mobile devices.
   *
   * @param incrementalCostUsd - The cost added in this update
   */
  private async broadcastToMobile(incrementalCostUsd: number): Promise<void> {
    if (!this.config.relay || !this.config.relay.isConnected()) {
      return;
    }

    try {
      await this.config.relay.send({
        type: 'cost_update',
        payload: {
          session_id: this.config.sessionId,
          agent: this.config.agentType,
          cost_usd: incrementalCostUsd,
          session_total_usd: this.sessionTotalCostUsd,
          tokens: {
            input: 0, // Summarized in batch, detailed breakdown not available here
            output: 0,
          },
          model: 'batch', // Batch update, individual models not specified
        },
      });

      this.emit('mobileBroadcast', {
        costUsd: incrementalCostUsd,
        sessionTotalUsd: this.sessionTotalCostUsd,
      });

      this.log('Mobile broadcast sent', {
        incrementalCostUsd,
        sessionTotalUsd: this.sessionTotalCostUsd,
      });
    } catch (error) {
      this.log('Mobile broadcast failed', { error });
      // Non-critical: don't emit error for broadcast failures
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Convert a CostRecord to Supabase format.
   *
   * @param record - Internal cost record
   * @returns Supabase-compatible record
   */
  private toSupabaseRecord(record: CostRecord): SupabaseCostRecord {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    return {
      user_id: this.config.userId,
      session_id: this.config.sessionId,
      agent_type: record.agentType,
      model: record.model,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      cache_read_tokens: record.cacheReadTokens,
      cache_write_tokens: record.cacheWriteTokens,
      cost_usd: record.costUsd,
      price_per_input_token: null, // Could be populated from MODEL_PRICING
      price_per_output_token: null,
      recorded_at: record.timestamp.toISOString(),
      record_date: dateStr,
    };
  }

  /**
   * Get the current session total cost.
   *
   * @returns Total cost in USD
   */
  getSessionTotal(): number {
    return this.sessionTotalCostUsd;
  }

  /**
   * Get the number of records reported so far.
   *
   * @returns Number of reported records
   */
  getReportedCount(): number {
    return this.reportedRecordCount;
  }

  /**
   * Get the number of pending records.
   *
   * @returns Number of pending records
   */
  getPendingCount(): number {
    return this.pendingRecords.length;
  }

  /**
   * Debug logging.
   */
  private log(message: string, data?: unknown): void {
    if (this.config.debug) {
      console.log(`[CostReporter:${this.config.agentType}]`, message, data || '');
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a cost reporter instance.
 *
 * @param config - Reporter configuration
 * @returns Configured cost reporter
 *
 * @example
 * const reporter = createCostReporter({
 *   supabase: supabaseClient,
 *   relay: relayClient,
 *   userId: 'user-123',
 *   sessionId: 'session-456',
 *   machineId: 'machine-789',
 *   agentType: 'claude',
 * });
 *
 * reporter.start();
 *
 * // Add cost records as they're extracted
 * reporter.addRecord(costRecord);
 *
 * // On session end
 * await reporter.stop();
 */
export function createCostReporter(config: CostReporterConfig): CostReporter {
  return new CostReporter(config);
}

// ============================================================================
// Exports
// ============================================================================

export default {
  CostReporter,
  createCostReporter,
};
