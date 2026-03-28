/**
 * JSONL Parser Benchmark
 *
 * Measures the performance of the readline-based JS JSONL parser against
 * synthetic files of increasing size. Outputs results as a markdown table.
 *
 * Run with:
 *   npx tsx packages/styrby-cli/src/costs/__benchmarks__/jsonl-benchmark.ts
 *
 * Environment variables:
 *   BENCHMARK_SIZES  — Comma-separated list of target file sizes in MB.
 *                      Defaults to "1,5,10,50".
 *   BENCHMARK_TMPDIR — Directory to write synthetic files. Defaults to OS temp.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { performance } from 'perf_hooks';
import { parseJsonlFile } from '../jsonl-parser.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Sizes (in MB) to benchmark. Can be overridden via BENCHMARK_SIZES env var. */
const TARGET_SIZES_MB: number[] = process.env.BENCHMARK_SIZES
  ? process.env.BENCHMARK_SIZES.split(',').map(Number).filter(Boolean)
  : [1, 5, 10, 50];

/** Directory to write synthetic test files. */
const TMP_DIR: string = process.env.BENCHMARK_TMPDIR ?? os.tmpdir();

// ---------------------------------------------------------------------------
// Synthetic data generation
// ---------------------------------------------------------------------------

/** Models to cycle through in synthetic data — mirrors real Claude sessions. */
const SYNTHETIC_MODELS = [
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];

/**
 * Generates a single realistic Claude Code JSONL line.
 *
 * Alternates between the two JSONL formats handled by the parser:
 * - `assistant` message with nested `message.usage` (primary Claude Code format)
 * - `cost_info` top-level field (secondary format)
 *
 * @param index - Line index, used to select model and vary token counts
 * @returns A JSON string (no trailing newline)
 */
function generateLine(index: number): string {
  const model = SYNTHETIC_MODELS[index % SYNTHETIC_MODELS.length];
  const timestamp = new Date(Date.now() - index * 1000).toISOString();

  // Vary token counts realistically (500–8000 input, 200–2000 output)
  const inputTokens = 500 + (index % 7500);
  const outputTokens = 200 + (index % 1800);
  const cacheReadTokens = index % 3 === 0 ? inputTokens * 0.4 | 0 : 0;
  const cacheWriteTokens = index % 5 === 0 ? inputTokens * 0.2 | 0 : 0;

  if (index % 2 === 0) {
    // Primary format: assistant message with nested usage
    return JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        model,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheWriteTokens,
        },
      },
    });
  } else {
    // Secondary format: cost_info top-level field
    return JSON.stringify({
      type: 'result',
      timestamp,
      cost_info: {
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
      },
    });
  }
}

/**
 * Generates a non-usage line (simulates the majority of JSONL events that
 * carry no cost data — human messages, tool calls, etc.).
 *
 * WHY: Real session files have ~90% non-usage lines. Including them in the
 * benchmark makes the line-skip overhead visible in the numbers.
 *
 * @param index - Line index for deterministic content
 * @returns A JSON string (no trailing newline)
 */
function generateNonUsageLine(index: number): string {
  const types = ['human', 'tool_result', 'system'] as const;
  return JSON.stringify({
    type: types[index % types.length],
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: `Synthetic content line ${index} — not a usage record.` },
  });
}

/**
 * Writes a synthetic JSONL file of approximately `targetSizeMB` megabytes.
 *
 * Mixes usage lines (every 10th line) and non-usage lines (the rest) to
 * simulate a realistic session transcript.
 *
 * @param targetSizeMB - Approximate target file size in megabytes
 * @param filePath - Destination path to write
 * @returns A promise resolving to the exact number of lines written
 */
async function writeSyntheticFile(targetSizeMB: number, filePath: string): Promise<number> {
  const targetBytes = targetSizeMB * 1024 * 1024;
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });

  let written = 0;
  let lineIndex = 0;

  while (written < targetBytes) {
    const line = lineIndex % 10 === 0
      ? generateLine(lineIndex)
      : generateNonUsageLine(lineIndex);

    const chunk = line + '\n';
    stream.write(chunk);
    written += Buffer.byteLength(chunk, 'utf8');
    lineIndex++;
  }

  // WHY: stream.end() is async — we must wait for the 'finish' event before
  // reading the file, otherwise statSync() or createReadStream() can race
  // against the OS flush and see a partial or missing file.
  await new Promise<void>((resolve, reject) => {
    stream.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return lineIndex;
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/**
 * Returns current process heap usage in megabytes.
 *
 * @returns Heap used in MB (rounded to 2 decimal places)
 */
function heapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/** Single benchmark result for one file size. */
interface BenchmarkResult {
  /** Target file size in MB (may differ slightly from actual due to line padding) */
  targetMB: number;
  /** Actual file size written in MB */
  actualMB: number;
  /** Number of lines in the file */
  totalLines: number;
  /** Number of TokenUsage records successfully parsed */
  parsedRecords: number;
  /** Parse duration in milliseconds */
  durationMs: number;
  /** Parse throughput in MB/s */
  mbPerSec: number;
  /** Parse throughput in lines/s */
  linesPerSec: number;
  /** Heap delta during parse in MB (approx) */
  heapDeltaMB: number;
}

/**
 * Runs the readline-based parser on a pre-generated synthetic file and
 * collects performance metrics.
 *
 * @param filePath - Path to the JSONL file
 * @param targetMB - Target size label for this file
 * @returns Benchmark result with timing, throughput, and memory data
 */
async function runBenchmark(filePath: string, targetMB: number): Promise<BenchmarkResult> {
  const stat = fs.statSync(filePath);
  const actualMB = Math.round(stat.size / 1024 / 1024 * 100) / 100;

  // Count lines without parsing (used for linesPerSec calculation)
  let totalLines = 0;
  await new Promise<void>((resolve) => {
    const lineCounter = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    lineCounter.on('line', () => totalLines++);
    lineCounter.on('close', resolve);
  });

  // Force GC if available to get clean heap baseline
  if (global.gc) global.gc();
  const heapBefore = heapMB();

  const t0 = performance.now();
  const records = await parseJsonlFile(filePath);
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;

  const heapAfter = heapMB();
  const heapDeltaMB = Math.round((heapAfter - heapBefore) * 100) / 100;

  const mbPerSec = Math.round((actualMB / (durationMs / 1000)) * 100) / 100;
  const linesPerSec = Math.round(totalLines / (durationMs / 1000));

  return {
    targetMB,
    actualMB,
    totalLines,
    parsedRecords: records.length,
    durationMs,
    mbPerSec,
    linesPerSec,
    heapDeltaMB,
  };
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

/**
 * Formats a number with thousands separators (e.g., 1234567 → "1,234,567").
 *
 * @param n - The number to format
 * @returns Formatted string with comma separators
 */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Renders benchmark results as a markdown table and prints it to stdout.
 *
 * @param results - Array of benchmark results from `runBenchmark()`
 */
function printMarkdownTable(results: BenchmarkResult[]): void {
  const header = [
    '| Target Size | Actual Size | Lines | Usage Records | Parse Time | Throughput (MB/s) | Throughput (lines/s) | Heap Δ (MB) |',
    '|-------------|-------------|-------|---------------|------------|-------------------|---------------------|-------------|',
  ];

  const rows = results.map((r) =>
    `| ${r.targetMB} MB | ${r.actualMB} MB | ${fmt(r.totalLines)} | ${fmt(r.parsedRecords)} | ${r.durationMs} ms | ${r.mbPerSec} | ${fmt(r.linesPerSec)} | ${r.heapDeltaMB} |`
  );

  console.log('\n## JS JSONL Parser Benchmark Results\n');
  console.log('**Parser:** Node.js `readline` + `JSON.parse()` (single-threaded)');
  console.log(`**Node.js version:** ${process.version}`);
  console.log(`**Platform:** ${process.platform} ${os.arch()}`);
  console.log(`**Date:** ${new Date().toISOString()}\n`);
  console.log([...header, ...rows].join('\n'));
  console.log('\n### Notes\n');
  console.log('- "Usage Records" = lines that contained `message.usage` or `cost_info` data');
  console.log('- Heap Δ is approximate; GC pauses may cause negative values on small files');
  console.log('- Run with `node --expose-gc` for more accurate memory figures\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point — generates synthetic files, benchmarks the JS parser, and
 * prints results as a markdown table.
 */
async function main(): Promise<void> {
  console.log('Generating synthetic JSONL files and benchmarking JS parser...\n');

  const results: BenchmarkResult[] = [];

  for (const sizeMB of TARGET_SIZES_MB) {
    const filePath = path.join(TMP_DIR, `styrby-bench-${sizeMB}mb.jsonl`);

    process.stdout.write(`  [${sizeMB} MB] Generating...`);
    const lineCount = await writeSyntheticFile(sizeMB, filePath);
    process.stdout.write(` ${fmt(lineCount)} lines written. Benchmarking...`);

    const result = await runBenchmark(filePath, sizeMB);
    results.push(result);

    process.stdout.write(` Done (${result.durationMs} ms)\n`);

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }

  printMarkdownTable(results);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
