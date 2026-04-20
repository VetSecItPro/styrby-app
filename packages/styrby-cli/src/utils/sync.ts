import { backoff } from "@/utils/time";

/**
 * A coalescing async-sync primitive that debounces rapid `invalidate()` calls
 * into at most one running and one pending execution of a command.
 *
 * WHY: When multiple async events (e.g., WebSocket messages, file-system
 * changes) each require a sync-to-server operation, naively awaiting each one
 * would queue many redundant network round-trips. `InvalidateSync` collapses
 * these into a single in-flight execution plus at most one queued re-run,
 * which is sufficient to guarantee eventual consistency without unnecessary
 * duplicate calls.
 *
 * Lifecycle:
 * 1. First `invalidate()` → starts `_doSync()` immediately.
 * 2. Additional `invalidate()` calls while sync is in progress → set the
 *    "double-invalidated" flag so a second run is queued automatically.
 * 3. After the first run completes, if the flag is set, a second run starts.
 * 4. `stop()` drains any waiting `invalidateAndAwait()` callers and prevents
 *    further syncs.
 *
 * The underlying command is wrapped in `backoff` so transient network errors
 * are retried automatically with exponential delay.
 *
 * @example
 * const sync = new InvalidateSync(async () => {
 *   await pushSessionToServer(localSession);
 * });
 *
 * // Fire-and-forget — coalesces concurrent calls automatically
 * wsMessageHandler = () => sync.invalidate();
 *
 * // Await completion when ordering matters
 * await sync.invalidateAndAwait();
 */
export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _pendings: (() => void)[] = [];

    /**
     * Creates a new `InvalidateSync` for the given async command.
     *
     * @param command - The async operation to execute on each sync cycle.
     *   Must be idempotent — it may be called more than once if invalidation
     *   occurs while a prior call is still in flight.
     */
    constructor(command: () => Promise<void>) {
        this._command = command;
    }

    /**
     * Marks the sync as dirty and starts a new sync cycle if none is running.
     *
     * Calling `invalidate()` while a sync is already in progress sets a
     * "double-invalidated" flag; the sync loop will execute one additional
     * cycle after the current one finishes. Further calls during that window
     * are no-ops (the flag is already set).
     *
     * Has no effect after `stop()` has been called.
     */
    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            if (!this._invalidatedDouble) {
                this._invalidatedDouble = true;
            }
        }
    }

    /**
     * Invalidates and returns a promise that resolves when the next full sync
     * cycle completes.
     *
     * WHY: Callers that must observe the post-sync state (e.g., UI waiting for
     * a confirmed server write) can await this instead of using fire-and-forget
     * `invalidate()`. The promise resolves after the sync command succeeds or
     * after `stop()` is called.
     *
     * Has no effect and resolves immediately after `stop()` has been called.
     */
    async invalidateAndAwait() {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.invalidate();
        });
    }

    /**
     * Stops the sync loop permanently and resolves all pending `invalidateAndAwait` callers.
     *
     * After `stop()`, calls to `invalidate()` and `invalidateAndAwait()` are
     * silently ignored. The in-flight command (if any) is allowed to complete
     * normally; the `_stopped` flag prevents subsequent cycles from starting.
     */
    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    /**
     * Resolves all queued `invalidateAndAwait` promises and clears the pending list.
     */
    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }

    /**
     * Internal sync loop: executes the command with backoff, then re-runs if
     * the double-invalidated flag was set during execution.
     */
    private _doSync = async () => {
        await backoff(async () => {
            if (this._stopped) {
                return;
            }
            await this._command();
        });
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}
