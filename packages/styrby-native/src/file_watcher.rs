//! # File Watcher — Cross-platform file system events with debouncing
//!
//! Provides low-latency file system change notifications to Node.js via
//! napi-rs. Built on the [`notify`](https://docs.rs/notify/) crate, which
//! uses platform-native APIs:
//! - **macOS**: FSEvents (low-level kernel notification, no polling)
//! - **Linux**: inotify (kernel subsystem, O(1) per event)
//! - **Windows**: ReadDirectoryChangesW (async Win32 API)
//!
//! ## Design
//!
//! Events from the OS arrive on a background thread. A 100 ms debounce window
//! batches rapid successive changes (e.g., editor save + temp file removal)
//! into a single notification, preventing the JS callback from being called
//! dozens of times per save.
//!
//! The watcher handle is managed by the JS side as an opaque object. Calling
//! `stopWatcher(handle)` stops the OS subscription and frees the thread.
//!
//! ## JavaScript interface (scaffold — not yet fully wired)
//!
//! ```ts
//! // Start watching a directory
//! const handle = watchDirectory('/path/to/dir', (events) => {
//!   for (const event of events) {
//!     console.log(event.kind, event.paths);
//!   }
//! });
//!
//! // Stop watching
//! stopWatcher(handle);
//! ```
//!
//! ## Status
//!
//! This module is scaffolded in Phase 3/Batch 4. The `watchDirectory` and
//! `stopWatcher` functions are exposed to Node.js but the underlying
//! notify watcher is fully implemented. Wire up the JS ThreadsafeFunction
//! callback bridge once the mobile push notification path is confirmed.

use crossbeam_channel::{bounded, Receiver, Sender};
use napi_derive::napi;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Watcher handle (exposed to Node.js as an opaque object)
// ---------------------------------------------------------------------------

/// Opaque handle for a running file watcher.
///
/// Holds a sender that, when dropped or explicitly stopped, signals the
/// background debounce thread to exit and stops the OS file watch subscription.
///
/// WHY: We store the watcher and sender inside an `Arc<Mutex<_>>` so the
/// handle can be passed back to JS and stored in a variable. When JS calls
/// `stopWatcher(handle)`, we lock and drop the inner resources.
#[napi]
pub struct WatcherHandle {
    /// Sending side of the stop channel. Dropping this signals the watcher thread.
    #[allow(dead_code)]
    stop_tx: Sender<()>,

    /// The underlying notify watcher. Must stay alive as long as we want events.
    #[allow(dead_code)]
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

// ---------------------------------------------------------------------------
// Event types exposed to JS
// ---------------------------------------------------------------------------

/// A single file system event delivered to the JS callback.
///
/// Field names are camelCase to match JavaScript conventions, since napi-rs
/// serialises `#[napi(object)]` structs with their Rust field names as-is.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct WatchEvent {
    /// Event kind: `"create"`, `"modify"`, `"remove"`, `"access"`, or `"other"`.
    pub kind: String,

    /// Affected file paths (may be empty for some event kinds on some platforms).
    pub paths: Vec<String>,
}

/// Converts a `notify::EventKind` to a stable string tag for JavaScript.
///
/// WHY: `notify::EventKind` is a complex Rust enum that cannot be serialised
/// directly through napi-rs. We flatten it to one of five stable string tags
/// that the JS side can switch on without importing Rust types.
fn event_kind_to_str(kind: &notify::EventKind) -> &'static str {
    match kind {
        notify::EventKind::Create(_) => "create",
        notify::EventKind::Modify(_) => "modify",
        notify::EventKind::Remove(_) => "remove",
        notify::EventKind::Access(_) => "access",
        _ => "other",
    }
}

/// Converts a `notify::Event` into a `WatchEvent` for JS consumption.
///
/// # Arguments
///
/// * `event` - A raw notify event from the OS notification system
///
/// # Returns
///
/// `WatchEvent` with the event kind string and affected paths as `String`s.
fn notify_event_to_watch_event(event: &Event) -> WatchEvent {
    WatchEvent {
        kind: event_kind_to_str(&event.kind).to_string(),
        paths: event
            .paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// Debounce logic
// ---------------------------------------------------------------------------

/// Debounce window in milliseconds.
///
/// WHY: Editors like VS Code and Neovim can produce 5–20 OS events per save
/// (temp file write, atomic rename, metadata update). A 100 ms window
/// collapses these into a single batch notification, preventing the JS
/// callback from firing dozens of times per keystroke.
const DEBOUNCE_MS: u64 = 100;

/// Runs the debounce loop on a background thread.
///
/// Drains the event channel with a `DEBOUNCE_MS` timeout. Any events that
/// arrive within the window are accumulated into a batch. When the window
/// expires (no new events), the batch is emitted via `batch_tx`.
///
/// # Arguments
///
/// * `event_rx` - Receives raw events from the notify watcher
/// * `stop_rx`  - Receives a stop signal when the caller drops the handle
/// * `batch_tx` - Sends debounced event batches for delivery to JS callback
fn run_debounce_loop(
    event_rx: Receiver<notify::Result<Event>>,
    stop_rx: Receiver<()>,
    batch_tx: Sender<Vec<WatchEvent>>,
) {
    let debounce = Duration::from_millis(DEBOUNCE_MS);
    let mut pending: Vec<WatchEvent> = Vec::new();

    loop {
        // Check for stop signal (non-blocking)
        if stop_rx.try_recv().is_ok() {
            break;
        }

        // Try to receive an event within the debounce window
        match event_rx.recv_timeout(debounce) {
            Ok(Ok(event)) => {
                pending.push(notify_event_to_watch_event(&event));
            }
            Ok(Err(_e)) => {
                // Notify watcher error — skip, keep running
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                // Debounce window elapsed — flush pending events
                if !pending.is_empty() {
                    let batch = std::mem::take(&mut pending);
                    if batch_tx.send(batch).is_err() {
                        break; // Receiver dropped — exit loop
                    }
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                break; // Watcher dropped — exit loop
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Node.js-exposed APIs
// ---------------------------------------------------------------------------

/// **Watch API** — Starts watching a directory for file system changes.
///
/// Spawns two background threads:
/// 1. **Notify watcher thread** (managed by the `notify` crate) — receives
///    raw OS events and forwards them to a bounded channel.
/// 2. **Debounce thread** (spawned here) — batches events within a 100 ms
///    window and forwards batches to a second channel for JS delivery.
///
/// # JavaScript signature
///
/// ```ts
/// function watchDirectory(
///   dirPath: string,
///   callback: (events: WatchEvent[]) => void
/// ): WatcherHandle
/// ```
///
/// # Arguments
///
/// * `dir_path` - Absolute path to the directory to watch (recursive)
/// * `callback` - JS function called with batched `WatchEvent[]` arrays
///
/// # Returns
///
/// A `WatcherHandle` that must be passed to `stopWatcher()` to clean up.
///
/// # Errors
///
/// Returns a `napi::Error` if the directory does not exist or cannot be watched.
///
/// # Note (scaffold status)
///
/// The `callback` parameter is captured but the ThreadsafeFunction bridge
/// that invokes it from the debounce thread is TODO — the JS fallback layer
/// does not use this API yet. The watcher and debounce threads start correctly;
/// wiring the callback requires resolving the napi-rs ThreadsafeFunction
/// lifetime constraints across the thread boundary.
#[napi]
pub fn watch_directory(
    dir_path: String,
    #[allow(unused_variables)] callback: napi::JsFunction,
) -> napi::Result<WatcherHandle> {
    // Channel for raw notify events (bounded to prevent unbounded memory if the
    // JS event loop is blocked and events pile up)
    let (event_tx, event_rx) = bounded::<notify::Result<Event>>(1024);

    // Channel for stop signal (capacity 1 — we only ever send once)
    let (stop_tx, stop_rx) = bounded::<()>(1);

    // Channel for debounced batches (capacity 64 — more than enough headroom)
    let (_batch_tx, _batch_rx) = bounded::<Vec<WatchEvent>>(64);
    let batch_tx_clone = _batch_tx.clone();

    // Create the OS-level file watcher
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            // Ignore send errors if the channel is full (drop events gracefully)
            let _ = event_tx.try_send(result);
        },
        Config::default(),
    )
    .map_err(|e| napi::Error::from_reason(format!("Failed to create watcher: {}", e)))?;

    // Start watching the target directory recursively
    watcher
        .watch(std::path::Path::new(&dir_path), RecursiveMode::Recursive)
        .map_err(|e| {
            napi::Error::from_reason(format!("Failed to watch {}: {}", dir_path, e))
        })?;

    // Spawn the debounce thread
    thread::spawn(move || {
        run_debounce_loop(event_rx, stop_rx, batch_tx_clone);
    });

    // TODO (Batch 4): Wire the `callback` parameter via a ThreadsafeFunction
    // so that debounced batches from `_batch_rx` are forwarded to JS.
    // The watcher is fully functional — only the JS callback bridge is pending.

    Ok(WatcherHandle {
        stop_tx,
        watcher: Arc::new(Mutex::new(Some(watcher))),
    })
}

/// **Stop API** — Stops a running file watcher and releases OS resources.
///
/// # JavaScript signature
///
/// ```ts
/// function stopWatcher(handle: WatcherHandle): void
/// ```
///
/// # Arguments
///
/// * `handle` - The `WatcherHandle` returned by `watchDirectory()`
///
/// # Errors
///
/// Returns a `napi::Error` if the watcher mutex is poisoned (should never
/// happen under normal usage).
#[napi]
pub fn stop_watcher(handle: &mut WatcherHandle) -> napi::Result<()> {
    // Signal the debounce thread to exit (it checks stop_tx's channel)
    // WHY: We send on the stop channel rather than dropping stop_tx so the
    // thread exits cleanly before we drop the underlying watcher. This avoids
    // a potential race where the notify callback fires after deregistration.
    let _ = handle.stop_tx.try_send(());

    // Drop the underlying watcher to deregister the OS file watch subscription
    if let Ok(mut guard) = handle.watcher.lock() {
        *guard = None;
    } else {
        return Err(napi::Error::from_reason("Watcher mutex is poisoned"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_event_kind_to_str_coverage() {
        use notify::event::{
            AccessKind, CreateKind, ModifyKind, RemoveKind,
        };
        assert_eq!(event_kind_to_str(&notify::EventKind::Create(CreateKind::Any)), "create");
        assert_eq!(event_kind_to_str(&notify::EventKind::Modify(ModifyKind::Any)), "modify");
        assert_eq!(event_kind_to_str(&notify::EventKind::Remove(RemoveKind::Any)), "remove");
        assert_eq!(event_kind_to_str(&notify::EventKind::Access(AccessKind::Any)), "access");
        assert_eq!(event_kind_to_str(&notify::EventKind::Other), "other");
    }

    #[test]
    fn test_notify_event_to_watch_event_paths() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        fs::write(&path, "").unwrap();

        let event = Event {
            kind: notify::EventKind::Create(notify::event::CreateKind::File),
            paths: vec![path.clone()],
            attrs: Default::default(),
        };

        let we = notify_event_to_watch_event(&event);
        assert_eq!(we.kind, "create");
        assert_eq!(we.paths.len(), 1);
        assert!(we.paths[0].contains("test.jsonl"));
    }

    #[test]
    fn test_debounce_batches_rapid_events() {
        let (event_tx, event_rx) = bounded::<notify::Result<Event>>(64);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let (batch_tx, batch_rx) = bounded::<Vec<WatchEvent>>(16);

        // Spawn debounce loop
        thread::spawn(move || {
            run_debounce_loop(event_rx, stop_rx, batch_tx);
        });

        // Send 5 rapid events
        for i in 0..5 {
            let event = Event {
                kind: notify::EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![std::path::PathBuf::from(format!("/tmp/file{}.jsonl", i))],
                attrs: Default::default(),
            };
            event_tx.send(Ok(event)).unwrap();
        }

        // Wait for debounce window to flush
        thread::sleep(Duration::from_millis(DEBOUNCE_MS * 3));
        stop_tx.send(()).unwrap();

        // Should receive one batch with all 5 events
        let batch = batch_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(batch.len(), 5, "all 5 events should be in one batch");
    }
}
