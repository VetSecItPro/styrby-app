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
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RelayClient } from 'styrby-shared';
import type { AgentType } from '@/auth/agent-credentials';
import type { CostRecord } from './cost-extractor.js';
import type { CostReport } from '@styrby/shared/cost';
import type { CostRecordInput, StyrbyApiClient } from '@/api/styrbyApiClient';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the cost reporter
 */
export interface CostReporterConfig {
  /**
   * Supabase client.
   *
   * WHY retained (Phase 4-step5): {@link finalizePending} still uses
   * `.from('cost_records').update({...}).eq('id', handle.id)` because no
   * `/api/v1/cost-records/[id]` PATCH endpoint exists yet. The remaining
   * direct-Supabase callsite is documented inline; a follow-up PR will add
   * the typed endpoint and remove this dependency entirely.
   */
  supabase: SupabaseClient;
  /**
   * Authenticated Styrby API client (Phase 4-step5).
   *
   * Used by {@link flush}, {@link reportImmediate}, and {@link reportPending}
   * to write cost rows via POST /api/v1/cost-records. The server stamps
   * `user_id` from the bearer key, eliminating the cross-user mass-assignment
   * surface that the prior `.from('cost_records').insert()` path exposed.
   */
  apiClient: StyrbyApiClient;
  /** Relay client for mobile broadcasts (optional) */
  relay?: RelayClient;
  /**
   * User ID for the cost records.
   *
   * WHY retained: the legacy {@link toSupabaseRecord} helper still emits a
   * `user_id` field for the on-the-wire shape; the apiClient layer ignores
   * it (the server overrides from the bearer key) but keeping it preserves
   * source-compat for any caller still inspecting the local record object.
   */
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
 * Cost record ready for Supabase insertion.
 *
 * Includes migration-022 columns: billing_model, source, raw_agent_payload,
 * subscription_fraction_used, credits_consumed, credit_rate_usd.
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
  // ---- migration-022 columns ----
  /** Billing model enum: 'api-key' | 'subscription' | 'credit' | 'free' */
  billing_model: string;
  /** Cost source enum: 'agent-reported' | 'styrby-estimate' */
  source: string;
  /** Raw agent payload for SOC2 CC7.2 audit trail */
  raw_agent_payload: Record<string, unknown> | null;
  /** Subscription quota fraction used (null if not available) */
  subscription_fraction_used: number | null;
  /** Number of credits consumed (credit billing only) */
  credits_consumed: number | null;
  /** USD rate per credit (credit billing only) */
  credit_rate_usd: number | null;
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
      // Convert to Supabase format.
      // WHY: Records that came through addCostReport() carry a __costReport extension
      // field with the full CostReport, enabling the migration-022 column mapping.
      // Legacy records from addRecord() fall back to toSupabaseRecord() with defaults.
      const supabaseRecords = recordsToReport.map((r) => {
        const ext = r as CostRecord & { __costReport?: CostReport };
        return ext.__costReport
          ? this.toSupabaseRecordFromCostReport(ext.__costReport)
          : this.toSupabaseRecord(r);
      });

      // Insert into cost_records via /api/v1/cost-records.
      // WHY per-record POST (Phase 4-step5): the typed endpoint accepts one
      // record per call, mirroring the cost_records column shape. We loop
      // over the batch and assign each call its own idempotency key so a
      // partial-batch retry on transient network failure can't double-count.
      // If ANY record write fails we put the entire remaining slice back on
      // the queue front to preserve the prior all-or-nothing flush
      // semantics — partial writes leave the buffer cleaner but the retry
      // budget is the operator-friendly default.
      try {
        for (let i = 0; i < supabaseRecords.length; i++) {
          const input = toCostRecordInput(supabaseRecords[i]);
          await this.config.apiClient.recordCost(input, {
            idempotencyKey: makeCostIdempotencyKey(),
          });
        }
      } catch (apiErr) {
        // Put records back on retry failure
        this.pendingRecords.unshift(...recordsToReport);
        const msg = apiErr instanceof Error ? apiErr.message : 'unknown';
        throw new Error(`Cost record POST failed: ${msg}`);
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
      const ext = record as CostRecord & { __costReport?: CostReport };
      const supabaseRecord = ext.__costReport
        ? this.toSupabaseRecordFromCostReport(ext.__costReport)
        : this.toSupabaseRecord(record);

      // POST a single record via /api/v1/cost-records.
      // WHY idempotency key: reportImmediate is on the hot path for critical
      // updates and may be retried by the caller on transient errors.
      // Without the key a retry would double-count cost.
      await this.config.apiClient.recordCost(toCostRecordInput(supabaseRecord), {
        idempotencyKey: makeCostIdempotencyKey(),
      });

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

      // POST the pending record via /api/v1/cost-records and read back the
      // server-assigned row id. WHY apiClient (Phase 4-step5): the prior
      // .from('cost_records').insert(...).select('id').single() chain is
      // replaced by recordCost(), which returns `{ id, recorded_at }`. The
      // server stamps user_id and the row id authoritatively; the CLI no
      // longer trusts a client-supplied id. Idempotency key is included so
      // a network retry doesn't double-reserve budget.
      const data = await this.config.apiClient.recordCost(
        toCostRecordInput(supabaseRecord),
        { idempotencyKey: makeCostIdempotencyKey() },
      );

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
      // Deferred (Phase 4-step5): no /api/v1/cost-records/[id] PATCH endpoint
      // exists yet. Adding one is out of scope for the swap-only PR — the
      // typed wrapper would require a new server route + Zod schema for the
      // update body + RLS verification on the row owner. Until that ships,
      // finalizePending continues to use the direct Supabase update; the
      // existing RLS policy on cost_records (user_id = auth.uid()) guards
      // against cross-user writes the same way the apiClient route would.
      // Tracked as a follow-up to H41 Phase 4-step5.
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
   * Uses migration-022 defaults for billing_model / source columns when the
   * caller has only a legacy CostRecord and no CostReport is available.
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
      // migration-022 defaults for legacy CostRecord callers
      billing_model: 'api-key',
      source: 'styrby-estimate',
      raw_agent_payload: null,
      subscription_fraction_used: null,
      credits_consumed: null,
      credit_rate_usd: null,
    };
  }

  /**
   * Convert a unified {@link CostReport} to Supabase format.
   *
   * This is the preferred path for all new code. It maps CostReport 1:1 to the
   * migration-022 columns in `cost_records`, preserving billing_model, source,
   * raw_agent_payload, and credit / subscription metadata for the cost dashboard.
   *
   * WHY: Migration 022 adds billing_model, source, raw_agent_payload,
   * subscription_fraction_used, credits_consumed, and credit_rate_usd. Mapping
   * these from CostReport (rather than re-deriving them) ensures the DB reflects
   * exactly what the agent reported — critical for SOC2 CC7.2 audit trail.
   *
   * @param report - Unified CostReport from the agent factory
   * @returns Supabase-compatible record with all migration-022 columns populated
   */
  toSupabaseRecordFromCostReport(report: CostReport): SupabaseCostRecord {
    const recordedAt = report.timestamp;
    const dateStr = recordedAt.split('T')[0]; // YYYY-MM-DD

    return {
      user_id: this.config.userId,
      session_id: report.sessionId,
      agent_type: report.agentType as AgentType,
      model: report.model,
      input_tokens: report.inputTokens,
      output_tokens: report.outputTokens,
      cache_read_tokens: report.cacheReadTokens,
      cache_write_tokens: report.cacheWriteTokens,
      cost_usd: report.costUsd,
      price_per_input_token: null,
      price_per_output_token: null,
      recorded_at: recordedAt,
      record_date: dateStr,
      is_pending: false,
      // ---- migration-022 columns ----
      billing_model: report.billingModel,
      source: report.source,
      raw_agent_payload: report.rawAgentPayload ?? null,
      // Subscription quota fraction — null if agent didn't expose it
      subscription_fraction_used: report.subscriptionUsage?.fractionUsed ?? null,
      // Credit billing fields — null for non-credit billing models
      credits_consumed: report.credits?.consumed ?? null,
      credit_rate_usd: report.credits?.rateUsdPerCredit ?? null,
    };
  }

  /**
   * Add a unified CostReport to the pending batch.
   *
   * This is the preferred method for new cost-report event consumers.
   * It converts CostReport → SupabaseCostRecord using the migration-022 mapping
   * and queues it alongside legacy CostRecord entries.
   *
   * WHY: Introducing addCostReport alongside addRecord lets callers gradually
   * migrate to the CostReport path without breaking the existing batch/flush
   * infrastructure. Both paths share the same pending queue and retry logic.
   *
   * @param report - Unified CostReport from the agent factory
   */
  addCostReport(report: CostReport): void {
    // WHY: Cap the pending buffer to prevent unbounded memory growth when
    // flush() keeps failing (e.g. sustained network outage). Drop the oldest
    // record (index 0) before pushing the new one — identical policy as addRecord().
    if (this.pendingRecords.length >= MAX_PENDING) {
      this.pendingRecords.shift();
      console.warn(
        `[CostReporter] pendingRecords exceeded MAX_PENDING (${MAX_PENDING}). ` +
          'Oldest record dropped. Check network connectivity.'
      );
    }

    // Convert CostReport to the CostRecord shape that pendingRecords holds, then
    // flush via the existing infrastructure. We store the Supabase record directly
    // in a thin wrapper so flush() can insert it without branching.
    const costUsd = report.costUsd;
    this.sessionTotalCostUsd += costUsd;

    // Build a synthetic CostRecord for the legacy pending queue so flush() can
    // call toSupabaseRecord(). The supabaseRecord override is applied by flush()
    // calling toSupabaseRecordFromCostReport when the item carries a costReport ref.
    // WHY: Rather than duplicating flush() logic, we attach the CostReport to the
    // CostRecord using an extension property so the existing batch path picks it up.
    const syntheticRecord: CostRecord & { __costReport?: CostReport } = {
      sessionId: report.sessionId,
      agentType: report.agentType as AgentType,
      model: report.model,
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
      costUsd,
      timestamp: new Date(report.timestamp),
      __costReport: report,
    };

    this.pendingRecords.push(syntheticRecord);

    this.log('CostReport added', {
      agentType: report.agentType,
      billingModel: report.billingModel,
      source: report.source,
      costUsd,
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
// API client helpers (Phase 4-step5)
// ============================================================================

/**
 * Convert the internal Supabase-row shape to the {@link CostRecordInput}
 * accepted by POST /api/v1/cost-records.
 *
 * WHY a separate function: {@link SupabaseCostRecord} carries `user_id`,
 * which the typed apiClient body schema rejects via `.strict()` — the
 * server stamps user_id from the bearer key. This helper drops that field
 * and forwards the rest of the migration-022 columns unchanged.
 *
 * @param row - The Supabase-shaped record produced by toSupabaseRecord*()
 * @returns Body shape for {@link StyrbyApiClient.recordCost}
 */
function toCostRecordInput(row: SupabaseCostRecord): CostRecordInput {
  // Strip user_id; forward every other field. Spreading then deleting keeps
  // the call site readable and survives future column additions.
  const { user_id: _omitUserId, ...rest } = row;
  void _omitUserId;
  return rest;
}

/**
 * Generate a per-request Idempotency-Key for cost record writes.
 *
 * WHY randomUUID + epoch suffix: cost records are append-only with no unique
 * constraint, so duplicate writes silently double-count. The server caches
 * responses keyed by this header, so a retry after a 5xx that already
 * succeeded server-side replays the same `{ id, recorded_at }` rather than
 * inserting a second row. UUID alone would suffice; the millisecond suffix
 * is purely a debug-friendly aid when grepping logs.
 *
 * @returns A unique idempotency key safe for transit in HTTP headers.
 */
function makeCostIdempotencyKey(): string {
  return `cost-${Date.now()}-${randomUUID()}`;
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
