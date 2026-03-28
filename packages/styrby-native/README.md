# @styrby/native

Rust native module for the Styrby CLI. Provides SIMD-accelerated JSONL parsing
and low-latency file watching via [napi-rs](https://napi.rs/).

## Features

- **JSONL Parser** — SIMD-accelerated (`simd-json` crate) + Rayon parallel batch mode
- **File Watcher** — cross-platform via the `notify` crate (FSEvents/inotify/ReadDirectoryChangesW)
- **JS Fallback** — if the `.node` binary is absent, automatically falls back to the pure-JS parser

## Build Requirements

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable ≥ 1.75 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| napi-rs CLI | ≥ 3.0 | `npm install -g @napi-rs/cli` |
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |

## Build

```bash
# Install dependencies
cd packages/styrby-native
npm install

# Build for the current platform only (fastest)
npm run build

# Build for all supported targets (darwin-arm64, darwin-x64, linux-x64-gnu)
npm run build:all
```

The compiled binary will be named `styrby-native.<platform>-<arch>.node`
(e.g., `styrby-native.darwin-arm64.node` on Apple Silicon).

## Usage

The module is consumed by `packages/styrby-cli` via the `STYRBY_NATIVE_PARSER=true`
environment variable. Set it to opt in:

```bash
STYRBY_NATIVE_PARSER=true styrby
```

Without the env var (default), the pure-JS readline parser is used regardless
of whether the native binary is present.

## Benchmark Results

Measured on macOS (Apple M3 Pro, 11 cores), Node.js v25.4.0:

| Target Size | Actual Size | Lines | Usage Records | Parse Time | Throughput (MB/s) | Throughput (lines/s) | Heap Δ (MB) |
|-------------|-------------|-------|---------------|------------|-------------------|---------------------|-------------|
| 1 MB | 1 MB | 6,743 | 675 | 13.73 ms | 72.83 | 491,114 | 3.55 |
| 5 MB | 5 MB | 33,549 | 3,355 | 59.49 ms | 84.05 | 563,944 | 9.55 |
| 10 MB | 10 MB | 67,032 | 6,704 | 101.38 ms | 98.64 | 661,196 | 20.36 |
| 50 MB | 50 MB | 333,561 | 33,357 | 486.91 ms | 102.69 | 685,057 | 15.31 |

**Parser:** Node.js `readline` + `JSON.parse()` (single-threaded JS baseline)

The Rust SIMD+Rayon implementation targets >500 MB/s on the same hardware.

## Supported Targets

| Target Triple | Platform |
|---------------|----------|
| `aarch64-apple-darwin` | macOS Apple Silicon (M1/M2/M3) |
| `x86_64-apple-darwin` | macOS Intel |
| `x86_64-unknown-linux-gnu` | Linux x64 (glibc) |

## Tests

```bash
npm test
```

Tests run against the JS fallback layer and pass without a compiled binary.

## Architecture

```
src/
├── lib.rs           — Module entry point, nativeVersion() export
├── jsonl_parser.rs  — SIMD JSONL parser (stream + batch APIs)
└── file_watcher.rs  — Cross-platform file watcher (scaffold)
index.js             — JS entry point with native/fallback routing
index.d.ts           — TypeScript declarations
```
