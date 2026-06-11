/**
 * Authoritative cost recovery from opencode's persisted session storage.
 *
 * WHY (root-cause fix for opencode issue #26855): opencode's `run --format json`
 * JSON loop can exit when it observes `session.status=idle` BEFORE it emits the
 * final `step-finish` event on stdout. The event is generated and persisted to
 * opencode's on-disk session storage, but never reaches our stdout parser — so
 * the last API call's cost would be silently lost. The issue is fixed in newer
 * opencode, but we cannot control which opencode version a user has installed,
 * and the maintainer's own guidance is that "the session database contains
 * complete usage data." So rather than depend on the best-effort stream, we
 * reconcile against that authoritative storage on process close. This module is
 * the pure, side-effect-free storage reader; the backend wires it into close.
 *
 * Storage layout (verified against a real opencode install, 2026-06-11):
 *   <root>/opencode/storage/message/<sessionID>/<msgID>.json   (assistant msgs)
 *   <root>/opencode/storage/part/<msgID>/<partID>.json         (step-finish etc.)
 * where <root> = $XDG_DATA_HOME or ~/.local/share. Part IDs (`prt_...`) are
 * monotonic/sortable, so filename sort == chronological order.
 *
 * @module agent/factories/opencodeStorage
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { toNonNegativeNumber } from '@/utils/coerce';

/** A step-finish usage record recovered from storage (one API call). */
export interface OpencodeStepFinish {
  /** Stable part id (`prt_...`), used to dedupe against stdout-seen events. */
  id: string;
  /** USD cost of this single API call. */
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Resolve the opencode (or fork) storage directory, honoring XDG.
 *
 * @param env - Environment to read XDG_DATA_HOME from. Default `process.env`.
 * @param product - Storage product dir name (default 'opencode'; forks differ).
 * @returns Absolute path to the `storage` dir.
 */
export function resolveOpencodeStorageDir(
  env: NodeJS.ProcessEnv = process.env,
  product = 'opencode',
): string {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== ''
    ? env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share');
  return join(base, product, 'storage');
}

/**
 * Read all `step-finish` parts for a given message, in chronological order.
 *
 * Best-effort and defensive: a missing dir, unreadable file, or malformed JSON
 * yields fewer/zero records rather than throwing — cost recovery must never
 * break the agent run.
 *
 * @param storageDir - The resolved storage dir (see resolveOpencodeStorageDir).
 * @param messageId - The assistant message id whose steps to read.
 * @returns Step-finish usage records, sorted by part id (chronological).
 */
export function readStepFinishParts(storageDir: string, messageId: string): OpencodeStepFinish[] {
  const dir = join(storageDir, 'part', messageId);
  if (!existsSync(dir)) return [];
  const out: OpencodeStepFinish[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>;
      if (p?.type !== 'step-finish') continue;
      const t = p.tokens ?? {};
      out.push({
        id: typeof p.id === 'string' ? p.id : f.replace(/\.json$/, ''),
        cost: toNonNegativeNumber(p.cost),
        inputTokens: toNonNegativeNumber(t.input),
        outputTokens: toNonNegativeNumber(t.output),
        cacheReadTokens: toNonNegativeNumber(t.cache?.read),
        cacheWriteTokens: toNonNegativeNumber(t.cache?.write),
      });
    } catch {
      // skip unreadable/malformed part
    }
  }
  return out;
}

/**
 * Find the most recent assistant message id for a session — the fallback used
 * to locate the just-finished turn when stdout gave us no `messageID` (e.g. a
 * total truncation where not even the first step-finish reached the stream).
 *
 * @param storageDir - The resolved storage dir.
 * @param sessionId - The opencode session id.
 * @returns The latest assistant message id, or null if none found.
 */
export function findLatestAssistantMessageId(storageDir: string, sessionId: string): string | null {
  const dir = join(storageDir, 'message', sessionId);
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  // Sortable ids → the latest assistant message is the last by filename.
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(readFileSync(join(dir, files[i]), 'utf8')) as Record<string, any>;
      if (m?.role === 'assistant') return typeof m.id === 'string' ? m.id : files[i].replace(/\.json$/, '');
    } catch {
      // skip
    }
  }
  return null;
}

/**
 * Decide which step-finish records were MISSED by the stdout stream and must be
 * recovered from storage, avoiding any double-count.
 *
 * Two regimes, chosen safely:
 *  - If stdout provided a part id for every step-finish it emitted
 *    (`seenIds.size === stdoutCount` and `stdoutCount > 0`), dedupe by id: emit
 *    exactly the storage parts whose id we did not already see.
 *  - Otherwise (ids unavailable/partial, or total truncation with stdoutCount=0),
 *    fall back to count-based trailing recovery: emit the storage parts after the
 *    first `stdoutCount` (the #26855 failure mode drops the TRAILING step(s)).
 *
 * @param storageParts - All step-finish parts for the turn's message (chronological).
 * @param seenIds - Part ids observed on stdout this turn (may be empty).
 * @param stdoutCount - Count of step-finish events observed on stdout this turn.
 * @returns The subset of storageParts to emit as recovered cost-reports.
 */
export function selectMissedStepFinishes(
  storageParts: OpencodeStepFinish[],
  seenIds: ReadonlySet<string>,
  stdoutCount: number,
): OpencodeStepFinish[] {
  const haveAllIds = stdoutCount > 0 && seenIds.size === stdoutCount;
  if (haveAllIds) {
    return storageParts.filter((p) => !seenIds.has(p.id));
  }
  // Count-based trailing recovery (also covers stdoutCount === 0 → recover all).
  return storageParts.slice(stdoutCount);
}
