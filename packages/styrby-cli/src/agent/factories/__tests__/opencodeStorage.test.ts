/**
 * Unit tests for `opencodeStorage` — the authoritative cost-recovery reader
 * that closes opencode issue #26855 (final step-finish dropped from stdout).
 *
 * The fs-reading functions are exercised against a temp dir populated with the
 * REAL opencode storage JSON shapes (captured from a live install 2026-06-11):
 *   storage/message/<sessionID>/<msgID>.json   role=assistant
 *   storage/part/<msgID>/<partID>.json         type=step-finish {cost,tokens}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveOpencodeStorageDir,
  readStepFinishParts,
  findLatestAssistantMessageId,
  selectMissedStepFinishes,
  type OpencodeStepFinish,
} from '../opencodeStorage';

// ---------------------------------------------------------------------------
// resolveOpencodeStorageDir — XDG handling
// ---------------------------------------------------------------------------

describe('resolveOpencodeStorageDir', () => {
  it('honors XDG_DATA_HOME when set', () => {
    expect(resolveOpencodeStorageDir({ XDG_DATA_HOME: '/data' } as NodeJS.ProcessEnv)).toBe(
      join('/data', 'opencode', 'storage'),
    );
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset/blank', () => {
    const got = resolveOpencodeStorageDir({ XDG_DATA_HOME: '  ' } as NodeJS.ProcessEnv);
    expect(got.endsWith(join('.local', 'share', 'opencode', 'storage'))).toBe(true);
  });

  it('supports a fork product dir name', () => {
    expect(resolveOpencodeStorageDir({ XDG_DATA_HOME: '/d' } as NodeJS.ProcessEnv, 'kilo')).toBe(
      join('/d', 'kilo', 'storage'),
    );
  });
});

// ---------------------------------------------------------------------------
// fs-reading functions — against a temp storage tree with real shapes
// ---------------------------------------------------------------------------

describe('readStepFinishParts + findLatestAssistantMessageId', () => {
  let storageDir: string;
  const SES = 'ses_test1';
  const MSG = 'msg_test1';

  beforeEach(() => {
    storageDir = join(mkdtempSync(join(tmpdir(), 'oc-store-')), 'storage');
    // message
    const msgDir = join(storageDir, 'message', SES);
    mkdirSync(msgDir, { recursive: true });
    writeFileSync(join(msgDir, `${MSG}.json`), JSON.stringify({ id: MSG, role: 'assistant', sessionID: SES }));
    writeFileSync(join(msgDir, 'msg_user.json'), JSON.stringify({ id: 'msg_user', role: 'user', sessionID: SES }));
    // parts: 2 step-finishes + a step-start + a text (must be filtered out)
    const partDir = join(storageDir, 'part', MSG);
    mkdirSync(partDir, { recursive: true });
    writeFileSync(join(partDir, 'prt_a.json'), JSON.stringify({ id: 'prt_a', type: 'step-start' }));
    writeFileSync(join(partDir, 'prt_b.json'), JSON.stringify({ id: 'prt_b', type: 'text', text: 'hi' }));
    writeFileSync(join(partDir, 'prt_c.json'), JSON.stringify({
      id: 'prt_c', type: 'step-finish', cost: 0.01, tokens: { input: 1000, output: 10, cache: { read: 1, write: 2 } },
    }));
    writeFileSync(join(partDir, 'prt_d.json'), JSON.stringify({
      id: 'prt_d', type: 'step-finish', cost: 0.02, tokens: { input: 1500, output: 20 },
    }));
  });

  afterEach(() => {
    rmSync(join(storageDir, '..'), { recursive: true, force: true });
  });

  it('reads only step-finish parts, coerced + sorted by id', () => {
    const parts = readStepFinishParts(storageDir, MSG);
    expect(parts.map((p) => p.id)).toEqual(['prt_c', 'prt_d']); // step-start/text filtered out, sorted
    expect(parts[0]).toEqual({ id: 'prt_c', cost: 0.01, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2 });
    expect(parts[1]).toMatchObject({ cost: 0.02, inputTokens: 1500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('returns [] for a message with no stored parts', () => {
    expect(readStepFinishParts(storageDir, 'msg_missing')).toEqual([]);
  });

  it('finds the latest assistant message id (ignores user messages)', () => {
    expect(findLatestAssistantMessageId(storageDir, SES)).toBe(MSG);
  });

  it('returns null when the session has no stored messages', () => {
    expect(findLatestAssistantMessageId(storageDir, 'ses_missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectMissedStepFinishes — the dedupe / recovery decision (pure)
// ---------------------------------------------------------------------------

describe('selectMissedStepFinishes', () => {
  const parts: OpencodeStepFinish[] = [
    { id: 'p1', cost: 0.01, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { id: 'p2', cost: 0.02, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { id: 'p3', cost: 0.03, inputTokens: 3, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];

  it('id regime: recovers exactly the step(s) whose id was not seen on stdout', () => {
    const missed = selectMissedStepFinishes(parts, new Set(['p1', 'p2']), 2);
    expect(missed.map((p) => p.id)).toEqual(['p3']); // the #26855 dropped-final case
  });

  it('complete stream: id regime recovers nothing (no double-count)', () => {
    expect(selectMissedStepFinishes(parts, new Set(['p1', 'p2', 'p3']), 3)).toEqual([]);
  });

  it('count regime (no ids on stdout): recovers the trailing missed step(s)', () => {
    const missed = selectMissedStepFinishes(parts, new Set(), 2);
    expect(missed.map((p) => p.id)).toEqual(['p3']);
  });

  it('total truncation (stdoutCount 0): recovers all stored steps', () => {
    expect(selectMissedStepFinishes(parts, new Set(), 0).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('count regime never recovers when stdout already saw all (no double-count)', () => {
    expect(selectMissedStepFinishes(parts, new Set(), 3)).toEqual([]);
  });
});
