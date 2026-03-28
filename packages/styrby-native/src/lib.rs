//! # styrby-native
//!
//! Rust native module for the Styrby CLI. Exposes high-performance Node.js
//! bindings via [napi-rs](https://napi.rs/) for two subsystems:
//!
//! - **JSONL parser** (`jsonl_parser` module) — SIMD-accelerated parsing of
//!   Claude Code session transcripts with an optional Rayon parallel batch mode.
//! - **File watcher** (`file_watcher` module) — low-latency cross-platform
//!   file system events via the `notify` crate, with debounced batching.
//!
//! ## JavaScript interface
//!
//! The module is loaded by `packages/styrby-native/index.js`, which wraps it
//! with a JS fallback so the CLI works even when the `.node` binary is absent
//! (e.g., unsupported platform, first-time install before build).
//!
//! ## Build
//!
//! ```bash
//! cd packages/styrby-native
//! npm install
//! npm run build            # native target only
//! npm run build:all        # darwin-arm64, darwin-x64, linux-x64-gnu
//! ```

#![deny(clippy::all)]
#![allow(clippy::upper_case_acronyms)]

use napi_derive::napi;

pub mod file_watcher;
pub mod jsonl_parser;

/// Returns the version string of this native module.
///
/// Useful for the JS fallback layer to confirm the native module loaded
/// correctly and report its version in diagnostic output.
///
/// # Returns
///
/// Semver string matching the `version` field in `Cargo.toml`.
///
/// # Example (JavaScript)
///
/// ```js
/// const native = require('./styrby-native.darwin-arm64.node');
/// console.log(native.nativeVersion()); // "0.1.0"
/// ```
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
