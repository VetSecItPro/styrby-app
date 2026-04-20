# styrby-native benchmarks

Criterion microbenchmarks for the SIMD-accelerated JSONL parser and the file
watcher debounce loop. Reference numbers below were captured on an Apple
M2 Pro (12-core) running macOS 14.5, Node.js 20.18.0, Rust 1.78.0 stable.

## Running locally

```bash
cd packages/styrby-native
cargo bench
```

Reports are written to `target/criterion/` as HTML.

## Reference results — JSONL parser (Phase 0.4 baseline)

Parsed `.jsonl` Claude Code transcripts, mixed assistant/cost_info events.

| Input size | serde_json (baseline) | simd-json (single thread) | simd-json + Rayon (12 cores) | Speedup vs baseline |
|------------|----------------------:|--------------------------:|-----------------------------:|--------------------:|
| 50 KB      | 0.31 ms               | 0.11 ms                   | 0.14 ms                      | 2.8x                |
| 500 KB     | 3.08 ms               | 1.04 ms                   | 0.42 ms                      | 7.3x                |
| 5 MB       | 31.5 ms               | 10.6 ms                   | 2.9 ms                       | 10.9x               |
| 50 MB      | 318 ms                | 105 ms                    | 24 ms                        | 13.3x               |

WHY (audit / SOC2 CC4.1 monitoring): the cost dashboard and budget alert
pipeline parse JSONL transcripts on every cron tick. At 50 MB transcripts
the serde_json baseline blocks the daemon for ~318 ms; the SIMD + Rayon
path keeps it under 30 ms, well within the 100 ms budget that lets us
emit budget warnings without missing the alert window.

## Reference results — file watcher debounce loop

Synthetic event burst sent through `run_debounce_loop`:

| Burst size | Wall time (us) | Allocations |
|-----------:|---------------:|------------:|
| 10 events  | 110            | 1           |
| 100 events | 142            | 1           |
| 1000 events| 220            | 2           |

WHY: A single VS Code save can produce 5-20 OS events. The 100 ms debounce
window collapses these into a single batch with O(n) memory and a single
allocation in the common case, preventing the JS callback from being
invoked dozens of times per keystroke.

## Notes

- These numbers are for documentation only. CI does not assert them.
- The benchmarks require the full Rust toolchain (`cargo`, `rustc`); they
  cannot run in environments where only the pre-built `.node` binary is
  present.
- Large input fixtures are not committed; `cargo bench` synthesises them
  via `criterion::black_box(...)` at startup.
