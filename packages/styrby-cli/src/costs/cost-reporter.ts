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
import type { RelayClient } from 'styrby-shared';
import type { AgentType } from '@/auth/agent-credentials';
import type { CostRecord } from './cost-extractor.js';

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
  is_pending: boolean;
}

/**
 * A pending cost record that has been written to the DB with input cost only.
 * Used to track which records need finalization when the agent responds.
 */
export interface PendingCostHandle {
  /** Database ID of the pending cost_record row */
  id: string;
  /** The input-only cost that was pre-reserved */
  reservedCostUsd: number;
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
// Constants
// ============================================================================

/**
 * Maximum number of records allowed in the pending buffer at any time.
 *
 * WHY: Under sustained network failure flush() keeps re-queuing records on
 * every batch interval. Without a cap, pendingRecords grows without bound,
 * causing unbounded memory growth in long CLI sessions with a dead network.
 * When the cap is reached we drop the oldest records (already the least
 * actionable data) and log a warning so the operator knows records were lost
 * (PERF-024). 500 records × ~200 bytes each ≈ 100 KB max buffer footprint.
 */
const MAX_PENDING = 500;

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
    // WHY: Cap the pending buffer to prevent unbounded memory growth when
    // flush() keeps failing (e.g. sustained network outage). Drop the oldest
    // record (index 0) before pushing the new one so the buffer never exceeds
    // MAX_PENDING entries. The oldest records are the least actionable —
    // they describe cost events far in the past that would be stale by the
    // time the network recovers (PERF-024).
    if (this.pendingRecords.length >= MAX_PENDING) {
      this.pendingRecords.shift();
      console.warn(
        `[CostReporter] pendingRecords exceeded MAX_PENDING (${MAX_PENDING}). ` +
          'Oldest record dropped. Check network connectivity.'
      );
    }

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
      // On failure, add to pending batch for retry.
      // Apply the same MAX_PENDING cap as addRecord() to prevent buffer
      // growth when reportImmediate() is called repeatedly during an outage.
      if (this.pendingRecords.length >= MAX_PENDING) {
        this.pendingRecords.shift();
        console.warn(
          `[CostReporter] pendingRecords exceeded MAX_PENDING (${MAX_PENDING}) ` +
            'during immediate-report retry. Oldest record dropped.'
        );
      }
      this.pendingRecords.push(record);
      this.emit('error', {
        message: 'Immediate report failed, queued for retry',
        error: error instanceof Error ? error : undefined,
      });
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Pending Cost Pre-Reservation (H-002b)
  // --------------------------------------------------------------------------

  /**
   * Pre-reserve input cost in the database before the AI agent responds.
   *
   * WHY: The budget check sums cost_records to enforce hard stops. Without
   * pre-reservation, the check sees stale data during the agent's response
   * window (30+ seconds). By writing the input cost immediately with
   * is_pending=true, the budget check sees the reservation right away.
   *
   * The record contains exact input cost (the CLI knows the token count and
   * model pricing at request time). Output cost is zero until finalized.
   *
   * @param record - Partial cost record with input-only data
   * @returns Handle for finalization, or null if the write failed
   */
  async reportPending(record: CostRecord): Promise<PendingCostHandle | null> {
    try {
      const supabaseRecord = this.toSupabaseRecord(record);
      supabaseRecord.is_pending = true;
      // Output tokens are zero at this point; only input cost is known
      supabaseRecord.output_tokens = 0;

      const { data, error } = await this.config.supabase
        .from('cost_records')
        .insert(supabaseRecord)
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(`Supabase insert failed: ${error?.message ?? 'no data returned'}`);
      }

      this.sessionTotalCostUsd += record.costUsd;

      this.log('Pending cost reserved', {
        id: data.id,
        inputCostUsd: record.costUsd,
        model: record.model,
        inputTokens: record.inputTokens,
      });

      return {
        id: data.id,
        reservedCostUsd: record.costUsd,
      };
    } catch (error) {
      this.log('Pending cost reservation failed', { error });
      this.emit('error', {
        message: 'Failed to reserve pending cost',
        error: error instanceof Error ? error : undefined,
      });
      return null;
    }
  }

  /**
   * Finalize a pending cost record with the actual full cost.
   *
   * Called by the CLI when the AI agent finishes responding and the real
   * token counts are known. Updates the pending row with actual input_tokens,
   * output_tokens, cost_usd, and sets is_pending=false.
   *
   * The session cost trigger (tr_update_session_cost_finalize) automatically
   * adjusts the session's aggregated totals by the delta.
   *
   * @param handle - The handle returned by reportPending()
   * @param finalRecord - The complete cost record with actual token counts
   * @returns True if the record was finalized successfully
   */
  async finalizePending(handle: PendingCostHandle, finalRecord: CostRecord): Promise<boolean> {
    try {
      const { error } = await this.config.supabase
        .from('cost_records')
        .update({
          input_tokens: finalRecord.inputTokens,
          output_tokens: finalRecord.outputTokens,
          cache_read_tokens: finalRecord.cacheReadTokens,
          cache_write_tokens: finalRecord.cacheWriteTokens,
          cost_usd: finalRecord.costUsd,
          is_pending: false,
        })
        .eq('id', handle.id);

      if (error) {
        throw new Error(`Supabase update failed: ${error.message}`);
      }

      // Adjust the session total: add the delta between final and reserved
      const costDelta = finalRecord.costUsd - handle.reservedCostUsd;
      this.sessionTotalCostUsd += costDelta;
      this.reportedRecordCount++;

      this.emit('reported', {
        count: 1,
        totalCostUsd: finalRecord.costUsd,
      });

      this.log('Pending cost finalized', {
        id: handle.id,
        reservedUsd: handle.reservedCostUsd,
        finalUsd: finalRecord.costUsd,
        deltaUsd: costDelta,
      });

      // Broadcast the final cost to mobile
      await this.broadcastToMobile(costDelta > 0 ? costDelta : 0);

      return true;
    } catch (error) {
      this.log('Pending cost finalization failed, falling back to addRecord', { error });
      this.emit('error', {
        message: 'Failed to finalize pending cost',
        error: error instanceof Error ? error : undefined,
      });
      // Fallback: add as a new record so cost is not lost
      this.addRecord(finalRecord);
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
      is_pending: false,
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
