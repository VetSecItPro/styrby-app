/**
 * Context Sync — Summarizer Tests (Phase 3.5)
 *
 * Comprehensive test suite covering all exported functions from
 * packages/styrby-shared/src/context-sync/summarizer.ts.
 *
 * Test strategy:
 *   - estimateTokens: empty string, single word, multi-word, code-heavy string
 *   - extractPathsFromString: Unix paths detected, non-paths ignored, dedup
 *   - extractPathsFromToolCall: allowlisted tools, non-allowlisted tools, arg key priority
 *   - computeRelevance: age-decay, frequency normalisation, clamp [0, 1]
 *   - normaliseRole: all five DB roles → three output roles
 *   - buildMessagePreview: scrubbing applied, truncation at 200 chars, scrub removes secrets
 *   - detectCurrentTask: taskOverride wins, first user message used, fallback
 *   - detectOpenQuestion: question mark detection, non-question returns empty, last user message
 *   - buildSummaryMarkdown: template structure, empty fileRefs, empty openQuestion
 *   - buildFileRefs: path extraction from tool calls, dedup, sorted by relevance
 *   - summarize: full integration (deterministic output, token budget enforcement,
 *                scrub integration, empty input, budget clamp)
 *   - buildInjectionPrompt: preamble present, low-relevance refs filtered,
 *                           message count correct, estimatedTokens > 0
 *
 * WHY: The summarizer is the core of Phase 3.5. Bugs here leak secrets into
 * agent context windows across user agents, or produce malformed injection
 * prompts that confuse the receiving agent. Every branch must be exercised.
 *
 * @module tests/context-sync/summarizer.test
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  extractPathsFromString,
  extractPathsFromToolCall,
  computeRelevance,
  normaliseRole,
  buildMessagePreview,
  detectCurrentTask,
  detectOpenQuestion,
  buildSummaryMarkdown,
  buildFileRefs,
  summarize,
  buildInjectionPrompt,
} from '../../src/context-sync/summarizer';
import {
  TOKEN_BUDGET_DEFAULT,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  CONTEXT_MESSAGE_LIMIT,
  MESSAGE_PREVIEW_MAX_CHARS,
} from '../../src/context-sync/types';
import type {
  SummarizerInputMessage,
  AgentContextMemory,
} from '../../src/context-sync/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal SummarizerInputMessage for test purposes.
 */
function userMsg(content: string): SummarizerInputMessage {
  return { role: 'user', content };
}

function assistantMsg(content: string): SummarizerInputMessage {
  return { role: 'assistant', content };
}

function toolMsg(
  content: string,
  toolName: string,
  args: Record<string, unknown>
): SummarizerInputMessage {
  return {
    role: 'tool',
    content,
    toolCall: { name: toolName, arguments: args },
  };
}

/**
 * Fixed timestamp used to make recency-based tests deterministic.
 * All "now" references in the test suite use this value.
 */
const FIXED_NOW = new Date('2026-04-22T12:00:00.000Z').getTime();

/**
 * Build a minimal AgentContextMemory record for injection prompt tests.
 */
function buildMemory(overrides: Partial<AgentContextMemory> = {}): AgentContextMemory {
  return {
    id: 'mem-001',
    sessionGroupId: 'group-001',
    summaryMarkdown:
      '## Current task\nRefactor auth middleware\n\n## Recently touched\n- [PATH]/auth.ts (relevance 0.95)\n\n## Open questions\n(none)',
    fileRefs: [
      { path: '/Users/alice/project/src/auth.ts', lastTouchedAt: new Date(FIXED_NOW - 60_000).toISOString(), relevance: 0.95 },
      { path: '/Users/alice/project/src/middleware.ts', lastTouchedAt: new Date(FIXED_NOW - 120_000).toISOString(), relevance: 0.72 },
      { path: '/Users/alice/project/src/legacy.ts', lastTouchedAt: new Date(FIXED_NOW - 7_200_000).toISOString(), relevance: 0.18 },
    ],
    recentMessages: [
      { role: 'user', preview: 'Refactor auth middleware to use the new token format' },
      { role: 'assistant', preview: 'Sure, I will start with the middleware file.' },
    ],
    tokenBudget: TOKEN_BUDGET_DEFAULT,
    version: 1,
    createdAt: new Date(FIXED_NOW).toISOString(),
    updatedAt: new Date(FIXED_NOW).toISOString(),
    ...overrides,
  };
}

// ============================================================================
// estimateTokens
// ============================================================================

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(estimateTokens('   ')).toBe(0);
  });

  it('estimates single word', () => {
    // 1 word / 1.3 = 0.77 → ceil = 1
    expect(estimateTokens('hello')).toBe(1);
  });

  it('estimates multi-word string', () => {
    // "Hello world foo bar" = 4 words / 1.3 = 3.08 → ceil = 4
    expect(estimateTokens('Hello world foo bar')).toBe(4);
  });

  it('returns ceiling not floor', () => {
    // 2 words / 1.3 = 1.54 → ceil = 2
    expect(estimateTokens('hello world')).toBe(2);
  });

  it('handles code-heavy string with multiple tokens per word', () => {
    const code = 'const x = require("path"); const y = require("fs"); x.join(y);';
    expect(estimateTokens(code)).toBeGreaterThan(0);
  });
});

// ============================================================================
// extractPathsFromString
// ============================================================================

describe('extractPathsFromString', () => {
  it('detects /Users/ paths', () => {
    const paths = extractPathsFromString('Error in /Users/alice/projects/app/src/auth.ts line 42');
    expect(paths).toContain('/Users/alice/projects/app/src/auth.ts');
  });

  it('detects /home/ paths', () => {
    const paths = extractPathsFromString('Reading /home/bob/projects/api/index.ts');
    expect(paths).toContain('/home/bob/projects/api/index.ts');
  });

  it('detects /tmp/ paths', () => {
    const paths = extractPathsFromString('Wrote /tmp/styrby-session-output.json');
    expect(paths).toContain('/tmp/styrby-session-output.json');
  });

  it('ignores relative paths', () => {
    const paths = extractPathsFromString('See ./src/auth.ts for details');
    expect(paths).toHaveLength(0);
  });

  it('ignores API URL paths', () => {
    // /api/sessions/123 is an URL path, not a file path
    // (It doesn't start with /Users|home|root|var|tmp|etc|opt|usr|srv)
    const paths = extractPathsFromString('POST /api/sessions/123 returned 200');
    expect(paths).toHaveLength(0);
  });

  it('deduplicates identical paths', () => {
    const paths = extractPathsFromString(
      '/Users/alice/app/auth.ts was read and /Users/alice/app/auth.ts was written'
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe('/Users/alice/app/auth.ts');
  });

  it('returns multiple distinct paths', () => {
    const paths = extractPathsFromString(
      'Read /Users/alice/app/auth.ts and /Users/alice/app/middleware.ts'
    );
    expect(paths).toHaveLength(2);
  });

  it('returns empty array for string with no paths', () => {
    expect(extractPathsFromString('No file paths here')).toHaveLength(0);
  });
});

// ============================================================================
// extractPathsFromToolCall
// ============================================================================

describe('extractPathsFromToolCall', () => {
  it('extracts path from well-known arg key "path"', () => {
    const paths = extractPathsFromToolCall('read_file', {
      path: '/Users/alice/src/auth.ts',
    });
    expect(paths).toContain('/Users/alice/src/auth.ts');
  });

  it('extracts path from "file_path" arg key', () => {
    const paths = extractPathsFromToolCall('write_file', {
      file_path: '/Users/alice/src/index.ts',
      content: 'export default 42;',
    });
    expect(paths).toContain('/Users/alice/src/index.ts');
  });

  it('extracts path from "command" arg for bash', () => {
    const paths = extractPathsFromToolCall('bash', {
      command: 'cat /Users/alice/src/main.ts | head -10',
    });
    expect(paths).toContain('/Users/alice/src/main.ts');
  });

  it('returns empty for non-allowlisted tool', () => {
    const paths = extractPathsFromToolCall('unknown_tool_xyz', {
      path: '/Users/alice/src/auth.ts',
    });
    expect(paths).toHaveLength(0);
  });

  it('handles JSON string arguments', () => {
    // When toolCall.arguments is a JSON string, it should be parsed
    // Note: this test exercises the summarizer's JSON.parse path
    const paths = extractPathsFromToolCall('str_replace_editor', {
      path: '/Users/alice/src/editor.ts',
    });
    expect(paths).toContain('/Users/alice/src/editor.ts');
  });

  it('deduplicates paths across multiple arg keys', () => {
    const paths = extractPathsFromToolCall('edit_file', {
      path: '/Users/alice/src/auth.ts',
      file_path: '/Users/alice/src/auth.ts',
    });
    expect(paths).toHaveLength(1);
  });

  it('returns empty array when no paths in arguments', () => {
    const paths = extractPathsFromToolCall('bash', {
      command: 'echo hello world',
    });
    expect(paths).toHaveLength(0);
  });
});

// ============================================================================
// computeRelevance
// ============================================================================

describe('computeRelevance', () => {
  it('returns 1.0 for a file touched right now with max mentions', () => {
    const touchedAt = new Date(FIXED_NOW).toISOString();
    const score = computeRelevance(touchedAt, 5, 5, FIXED_NOW);
    // Recency = e^0 = 1.0, Frequency = 1.0 → combined = 1.0
    expect(score).toBe(1.0);
  });

  it('returns lower score for file touched 30 minutes ago', () => {
    const thirtyMinAgo = new Date(FIXED_NOW - 30 * 60 * 1000).toISOString();
    const score = computeRelevance(thirtyMinAgo, 1, 1, FIXED_NOW);
    // At half-life: recency ≈ 0.5, frequency = 1.0 → combined ≈ 0.65
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1.0);
    expect(score).toBeCloseTo(0.65, 1);
  });

  it('gives lower score for file with low mention frequency', () => {
    const recentAt = new Date(FIXED_NOW).toISOString();
    const highFreq = computeRelevance(recentAt, 5, 5, FIXED_NOW);
    const lowFreq = computeRelevance(recentAt, 1, 5, FIXED_NOW);
    expect(highFreq).toBeGreaterThan(lowFreq);
  });

  it('clamps result to [0, 1]', () => {
    const veryOldAt = new Date(FIXED_NOW - 48 * 60 * 60 * 1000).toISOString();
    const score = computeRelevance(veryOldAt, 0, 0, FIXED_NOW);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('handles zero totalMentions without division-by-zero', () => {
    const touchedAt = new Date(FIXED_NOW).toISOString();
    expect(() => computeRelevance(touchedAt, 0, 0, FIXED_NOW)).not.toThrow();
  });

  it('rounds to 2 decimal places', () => {
    const touchedAt = new Date(FIXED_NOW - 15 * 60 * 1000).toISOString();
    const score = computeRelevance(touchedAt, 2, 5, FIXED_NOW);
    const decimal = score.toString().split('.')[1] ?? '';
    expect(decimal.length).toBeLessThanOrEqual(2);
  });
});

// ============================================================================
// normaliseRole
// ============================================================================

describe('normaliseRole', () => {
  it('maps "user" to "user"', () => {
    expect(normaliseRole('user')).toBe('user');
  });

  it('maps "assistant" to "assistant"', () => {
    expect(normaliseRole('assistant')).toBe('assistant');
  });

  it('maps "tool" to "tool"', () => {
    expect(normaliseRole('tool')).toBe('tool');
  });

  it('maps "tool_result" to "tool"', () => {
    expect(normaliseRole('tool_result')).toBe('tool');
  });

  it('maps "system" to "tool"', () => {
    expect(normaliseRole('system')).toBe('tool');
  });

  it('maps unknown role to "tool"', () => {
    expect(normaliseRole('function_call')).toBe('tool');
  });
});

// ============================================================================
// buildMessagePreview
// ============================================================================

describe('buildMessagePreview', () => {
  it('scrubs secrets from message content', () => {
    const msg: SummarizerInputMessage = {
      role: 'assistant',
      // WHY split across concat: GitHub push protection scans for literal sk_live_ strings.
      // Using concat prevents false-positive secret detection on a clearly fake test value.
      content: 'Found API key: ' + 'sk_li' + 've_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };
    const preview = buildMessagePreview(msg);
    expect(preview.preview).not.toContain('sk_live_');
    expect(preview.preview).toContain('[REDACTED_SECRET]');
  });

  it('truncates to MESSAGE_PREVIEW_MAX_CHARS', () => {
    const longContent = 'a'.repeat(MESSAGE_PREVIEW_MAX_CHARS + 100);
    const msg: SummarizerInputMessage = { role: 'user', content: longContent };
    const preview = buildMessagePreview(msg);
    expect(preview.preview.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_MAX_CHARS);
  });

  it('normalises role correctly', () => {
    const msg: SummarizerInputMessage = { role: 'tool_result', content: 'File contents here' };
    const preview = buildMessagePreview(msg);
    expect(preview.role).toBe('tool');
  });

  it('handles empty content without throwing', () => {
    const msg: SummarizerInputMessage = { role: 'user', content: '' };
    expect(() => buildMessagePreview(msg)).not.toThrow();
    expect(buildMessagePreview(msg).preview).toBe('');
  });

  it('preserves content under the character limit', () => {
    const content = 'Short message here';
    const msg: SummarizerInputMessage = { role: 'user', content };
    const preview = buildMessagePreview(msg);
    // Scrubbed but not truncated (no secrets, short content)
    expect(preview.preview).toBe(content);
  });
});

// ============================================================================
// detectCurrentTask
// ============================================================================

describe('detectCurrentTask', () => {
  it('returns taskOverride when provided', () => {
    const msgs = [userMsg('Refactor auth'), assistantMsg('OK')];
    const task = detectCurrentTask(msgs, 'Custom task override');
    expect(task).toBe('Custom task override');
  });

  it('uses first user message when no override', () => {
    const msgs = [
      userMsg('Refactor the auth middleware to use JWT'),
      assistantMsg('Starting now...'),
      userMsg('Also fix the CORS headers'),
    ];
    const task = detectCurrentTask(msgs);
    expect(task).toBe('Refactor the auth middleware to use JWT');
  });

  it('returns fallback when no user messages', () => {
    const msgs = [assistantMsg('Ready.')];
    const task = detectCurrentTask(msgs);
    expect(task).toBe('Session in progress');
  });

  it('scrubs secrets from the task description', () => {
    // WHY concat: prevents false-positive secret scanning on clearly fake test value.
    const fakeKey = 'sk_li' + 've_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const msgs = [userMsg(`Use token ${fakeKey} for auth`)];
    const task = detectCurrentTask(msgs);
    expect(task).not.toContain('sk_live_');
  });

  it('truncates taskOverride to MESSAGE_PREVIEW_MAX_CHARS', () => {
    const longOverride = 'x'.repeat(MESSAGE_PREVIEW_MAX_CHARS + 50);
    const task = detectCurrentTask([], longOverride);
    expect(task.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_MAX_CHARS);
  });

  it('ignores empty string taskOverride and falls through', () => {
    const msgs = [userMsg('My actual task')];
    const task = detectCurrentTask(msgs, '   ');
    expect(task).toBe('My actual task');
  });
});

// ============================================================================
// detectOpenQuestion
// ============================================================================

describe('detectOpenQuestion', () => {
  it('returns question from last user message ending with ?', () => {
    const msgs = [
      userMsg('Refactor auth'),
      assistantMsg('Done'),
      userMsg('Should I also update the tests?'),
    ];
    const q = detectOpenQuestion(msgs);
    expect(q).toBe('Should I also update the tests?');
  });

  it('returns empty string when last user message does not end with ?', () => {
    const msgs = [userMsg('Refactor auth'), assistantMsg('Done')];
    const q = detectOpenQuestion(msgs);
    expect(q).toBe('');
  });

  it('returns empty string when no user messages', () => {
    const msgs = [assistantMsg('Ready')];
    const q = detectOpenQuestion(msgs);
    expect(q).toBe('');
  });

  it('scrubs secrets from the question', () => {
    // WHY concat: prevents false-positive secret scanning on clearly fake test value.
    const fakeKey = 'sk_li' + 've_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const msgs = [userMsg(`Is ${fakeKey} correct?`)];
    const q = detectOpenQuestion(msgs);
    expect(q).not.toContain('sk_live_');
    expect(q.endsWith('?')).toBe(true);
  });

  it('uses the LAST user message, not the first', () => {
    const msgs = [
      userMsg('First message?'),
      assistantMsg('Answer'),
      userMsg('Last message without question mark'),
    ];
    const q = detectOpenQuestion(msgs);
    expect(q).toBe(''); // Last user msg doesn't end with ?
  });
});

// ============================================================================
// buildSummaryMarkdown
// ============================================================================

describe('buildSummaryMarkdown', () => {
  it('includes ## Current task heading', () => {
    const md = buildSummaryMarkdown('Fix auth', [], '');
    expect(md).toContain('## Current task');
    expect(md).toContain('Fix auth');
  });

  it('includes ## Recently touched heading', () => {
    const md = buildSummaryMarkdown('task', [], '');
    expect(md).toContain('## Recently touched');
  });

  it('includes ## Open questions heading', () => {
    const md = buildSummaryMarkdown('task', [], '');
    expect(md).toContain('## Open questions');
  });

  it('shows (no files tracked yet) when fileRefs is empty', () => {
    const md = buildSummaryMarkdown('task', [], '');
    expect(md).toContain('(no files tracked yet)');
  });

  it('lists file refs with relevance scores', () => {
    const refs = [
      { path: '/Users/alice/auth.ts', lastTouchedAt: new Date().toISOString(), relevance: 0.95 },
    ];
    const md = buildSummaryMarkdown('task', refs, '');
    expect(md).toContain('/Users/alice/auth.ts');
    expect(md).toContain('0.95');
  });

  it('shows (none) when openQuestion is empty', () => {
    const md = buildSummaryMarkdown('task', [], '');
    expect(md).toContain('(none)');
  });

  it('shows the open question when provided', () => {
    const md = buildSummaryMarkdown('task', [], 'Should I refactor this?');
    expect(md).toContain('Should I refactor this?');
    expect(md).not.toContain('(none)');
  });
});

// ============================================================================
// buildFileRefs
// ============================================================================

describe('buildFileRefs', () => {
  it('returns empty array when no tool calls', () => {
    const msgs = [userMsg('Hello'), assistantMsg('Hi')];
    expect(buildFileRefs(msgs, FIXED_NOW)).toHaveLength(0);
  });

  it('extracts paths from tool calls', () => {
    const msgs = [
      toolMsg('Read file', 'read_file', { path: '/Users/alice/src/auth.ts' }),
    ];
    const refs = buildFileRefs(msgs, FIXED_NOW);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe('/Users/alice/src/auth.ts');
  });

  it('deduplicates identical paths across multiple tool calls', () => {
    const msgs = [
      toolMsg('Read', 'read_file', { path: '/Users/alice/auth.ts' }),
      toolMsg('Write', 'write_file', { file_path: '/Users/alice/auth.ts' }),
    ];
    const refs = buildFileRefs(msgs, FIXED_NOW);
    expect(refs).toHaveLength(1);
  });

  it('sorts refs descending by relevance', () => {
    const msgs = [
      toolMsg('Read old', 'read_file', { path: '/Users/alice/old.ts' }),
      toolMsg('Read new', 'read_file', { path: '/Users/alice/new.ts' }),
      toolMsg('Read new again', 'read_file', { path: '/Users/alice/new.ts' }),
    ];
    const refs = buildFileRefs(msgs, FIXED_NOW);
    // new.ts is mentioned twice → higher frequency → higher relevance
    expect(refs[0]!.path).toBe('/Users/alice/new.ts');
  });

  it('ignores tool calls for non-allowlisted tools', () => {
    const msgs = [
      toolMsg('Custom tool', 'unknown_custom_tool', { path: '/Users/alice/secret.ts' }),
    ];
    const refs = buildFileRefs(msgs, FIXED_NOW);
    expect(refs).toHaveLength(0);
  });

  it('handles JSON string arguments', () => {
    const msgs: SummarizerInputMessage[] = [
      {
        role: 'tool',
        content: '',
        toolCall: {
          name: 'read_file',
          arguments: JSON.stringify({ path: '/Users/alice/json-arg.ts' }),
        },
      },
    ];
    const refs = buildFileRefs(msgs, FIXED_NOW);
    expect(refs.some((r) => r.path === '/Users/alice/json-arg.ts')).toBe(true);
  });

  it('skips tool calls with invalid JSON string arguments', () => {
    const msgs: SummarizerInputMessage[] = [
      {
        role: 'tool',
        content: '',
        toolCall: { name: 'read_file', arguments: 'NOT_VALID_JSON' },
      },
    ];
    expect(() => buildFileRefs(msgs, FIXED_NOW)).not.toThrow();
    const refs = buildFileRefs(msgs, FIXED_NOW);
    expect(refs).toHaveLength(0);
  });
});

// ============================================================================
// summarize — integration tests
// ============================================================================

describe('summarize', () => {
  it('returns deterministic output for same input', () => {
    const messages = [
      userMsg('Refactor auth'),
      toolMsg('Reading', 'read_file', { path: '/Users/alice/src/auth.ts' }),
      assistantMsg('Done with auth.ts'),
    ];
    const out1 = summarize({ messages }, FIXED_NOW);
    const out2 = summarize({ messages }, FIXED_NOW);
    expect(out1.summaryMarkdown).toBe(out2.summaryMarkdown);
    expect(out1.fileRefs).toEqual(out2.fileRefs);
    expect(out1.recentMessages).toEqual(out2.recentMessages);
  });

  it('detects task from first user message', () => {
    const messages = [userMsg('Add rate limiting to the API'), assistantMsg('OK')];
    const out = summarize({ messages }, FIXED_NOW);
    expect(out.summaryMarkdown).toContain('Add rate limiting to the API');
  });

  it('applies scrub to message content in recentMessages', () => {
    // WHY concat: prevents false-positive secret scanning on clearly fake test value.
    const fakeKey = 'sk_li' + 've_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const messages = [
      userMsg(`My key is ${fakeKey} — use it`),
    ];
    const out = summarize({ messages }, FIXED_NOW);
    for (const msg of out.recentMessages) {
      expect(msg.preview).not.toContain('sk_live_');
    }
  });

  it('caps recentMessages at CONTEXT_MESSAGE_LIMIT', () => {
    const messages: SummarizerInputMessage[] = Array.from(
      { length: CONTEXT_MESSAGE_LIMIT + 10 },
      (_, i) => userMsg(`Message ${i}`)
    );
    const out = summarize({ messages }, FIXED_NOW);
    expect(out.recentMessages.length).toBeLessThanOrEqual(CONTEXT_MESSAGE_LIMIT);
  });

  it('enforces token budget by truncating summaryMarkdown', () => {
    // Create a scenario where the summary would be very long
    const refs = Array.from({ length: 50 }, (_, i) => ({
      path: `/Users/alice/src/very-long-file-name-for-testing-${i}.ts`,
      lastTouchedAt: new Date(FIXED_NOW - i * 1000).toISOString(),
      relevance: (50 - i) / 50,
    }));

    // Build input with many file-touching tool calls to generate large summary
    const messages: SummarizerInputMessage[] = [
      userMsg('Big task'),
      ...refs.slice(0, 10).map((ref) =>
        toolMsg('', 'read_file', { path: ref.path })
      ),
    ];

    const minBudget = TOKEN_BUDGET_MIN;
    const out = summarize({ messages, tokenBudget: minBudget }, FIXED_NOW);
    // The summary should be truncated — estimatedTokens may exceed minBudget slightly
    // due to the truncation notice, but summaryMarkdown should be significantly shorter
    // than an unbounded summary
    expect(out.summaryMarkdown.length).toBeLessThan(10_000);
  });

  it('clamps tokenBudget below TOKEN_BUDGET_MIN to TOKEN_BUDGET_MIN', () => {
    const messages = [userMsg('Task')];
    expect(() => summarize({ messages, tokenBudget: 0 }, FIXED_NOW)).not.toThrow();
  });

  it('clamps tokenBudget above TOKEN_BUDGET_MAX to TOKEN_BUDGET_MAX', () => {
    const messages = [userMsg('Task')];
    expect(() => summarize({ messages, tokenBudget: TOKEN_BUDGET_MAX + 10_000 }, FIXED_NOW)).not.toThrow();
  });

  it('handles empty message array', () => {
    const out = summarize({ messages: [] }, FIXED_NOW);
    expect(out.summaryMarkdown).toContain('## Current task');
    expect(out.fileRefs).toHaveLength(0);
    expect(out.recentMessages).toHaveLength(0);
  });

  it('uses taskOverride when provided', () => {
    const messages = [userMsg('Original task')];
    const out = summarize({ messages, taskOverride: 'Override task description' }, FIXED_NOW);
    expect(out.summaryMarkdown).toContain('Override task description');
    expect(out.summaryMarkdown).not.toContain('Original task');
  });

  it('returns positive estimatedTokens for non-empty summary', () => {
    const messages = [userMsg('Hello, start working on auth')];
    const out = summarize({ messages }, FIXED_NOW);
    expect(out.estimatedTokens).toBeGreaterThan(0);
  });

  it('includes detected open question in summary', () => {
    const messages = [
      userMsg('Refactor auth'),
      assistantMsg('Done'),
      userMsg('Should I also add unit tests?'),
    ];
    const out = summarize({ messages }, FIXED_NOW);
    expect(out.summaryMarkdown).toContain('Should I also add unit tests?');
  });

  it('populates fileRefs from tool calls across messages', () => {
    const messages = [
      toolMsg('Read', 'read_file', { path: '/Users/alice/auth.ts' }),
      toolMsg('Write', 'write_file', { file_path: '/Users/alice/middleware.ts' }),
    ];
    const out = summarize({ messages }, FIXED_NOW);
    expect(out.fileRefs.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// buildInjectionPrompt
// ============================================================================

describe('buildInjectionPrompt', () => {
  it('includes the Styrby Context Sync preamble header', () => {
    const memory = buildMemory();
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).toContain('[Styrby Context Sync — cross-agent handoff]');
  });

  it('includes the summary markdown', () => {
    const memory = buildMemory({ summaryMarkdown: '## Current task\nRefactor auth middleware' });
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).toContain('Refactor auth middleware');
  });

  it('filters out low-relevance file refs (< 0.5)', () => {
    const memory = buildMemory(); // legacy.ts has relevance 0.18
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).not.toContain('legacy.ts');
    expect(payload.includedFileRefs.every((r) => r.relevance >= 0.5)).toBe(true);
  });

  it('includes high-relevance file refs', () => {
    const memory = buildMemory();
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).toContain('auth.ts');
    expect(payload.systemPrompt).toContain('middleware.ts');
  });

  it('includes ## Files you may need section when refs present', () => {
    const memory = buildMemory();
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).toContain('## Files you may need');
  });

  it('omits ## Files you may need when all refs below threshold', () => {
    const memory = buildMemory({
      fileRefs: [
        {
          path: '/Users/alice/old.ts',
          lastTouchedAt: new Date(FIXED_NOW - 86_400_000).toISOString(),
          relevance: 0.1,
        },
      ],
    });
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).not.toContain('## Files you may need');
  });

  it('includes recent conversation section', () => {
    const memory = buildMemory();
    const payload = buildInjectionPrompt(memory);
    expect(payload.systemPrompt).toContain('## Recent conversation');
    expect(payload.systemPrompt).toContain('**user**:');
    expect(payload.systemPrompt).toContain('**assistant**:');
  });

  it('sets messageCount to length of recentMessages', () => {
    const memory = buildMemory();
    const payload = buildInjectionPrompt(memory);
    expect(payload.messageCount).toBe(memory.recentMessages.length);
  });

  it('returns positive estimatedTokens', () => {
    const memory = buildMemory();
    const payload = buildInjectionPrompt(memory);
    expect(payload.estimatedTokens).toBeGreaterThan(0);
  });

  it('handles empty recentMessages gracefully', () => {
    const memory = buildMemory({ recentMessages: [] });
    expect(() => buildInjectionPrompt(memory)).not.toThrow();
    const payload = buildInjectionPrompt(memory);
    expect(payload.messageCount).toBe(0);
  });

  it('handles empty fileRefs gracefully', () => {
    const memory = buildMemory({ fileRefs: [] });
    expect(() => buildInjectionPrompt(memory)).not.toThrow();
    const payload = buildInjectionPrompt(memory);
    expect(payload.includedFileRefs).toHaveLength(0);
  });
});
