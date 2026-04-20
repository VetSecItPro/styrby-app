/**
 * A simple async mutual-exclusion lock for Node.js single-threaded async code.
 *
 * WHY: JavaScript is single-threaded but async operations create interleaving
 * hazards when shared state must be updated atomically (e.g., writing an
 * encrypted session file, modifying a key store). `AsyncLock` serializes
 * concurrent async callers using a permit counter and a resolver queue,
 * ensuring only one critical section executes at a time without blocking
 * the event loop.
 *
 * @example
 * const lock = new AsyncLock();
 *
 * // Callers will queue and execute one at a time
 * await lock.inLock(async () => {
 *   const data = await readFile('key.bin');
 *   await writeFile('key.bin', encrypt(data));
 * });
 */
export class AsyncLock {
    private permits: number = 1;
    private promiseResolverQueue: Array<(v: boolean) => void> = [];

    /**
     * Acquires the lock, executes `func`, then releases the lock.
     *
     * The lock is released in a `finally` block so it is always freed even if
     * `func` throws. Callers that arrive while the lock is held are queued and
     * resume in FIFO order.
     *
     * @param func - Async (or sync) function to execute inside the critical section.
     * @returns A promise that resolves to the return value of `func`.
     * @throws Re-throws any error thrown by `func` after releasing the lock.
     *
     * @example
     * const result = await lock.inLock(async () => {
     *   return await fetchAndCacheData();
     * });
     */
    async inLock<T>(func: () => Promise<T> | T): Promise<T> {
        try {
            await this.lock();
            return await func();
        } finally {
            this.unlock();
        }
    }

    /**
     * Acquires the lock permit, blocking until it is available.
     *
     * WHY: Uses a promise resolver queue rather than polling so that waiting
     * callers do not spin and the event loop remains unblocked. A permit counter
     * of 1 enforces mutual exclusion; 0 means the lock is held.
     *
     * @returns A promise that resolves when the permit is granted.
     */
    private async lock() {
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            return;
        }
        await new Promise<boolean>(resolve => this.promiseResolverQueue.push(resolve));
    }

    /**
     * Releases the lock permit and wakes the next queued waiter, if any.
     *
     * WHY: The next waiter is resumed via `setTimeout(..., 0)` (next event-loop
     * tick) so the current stack fully unwinds before the next critical section
     * begins, avoiding subtle re-entrancy bugs.
     *
     * @throws {Error} If `permits` exceeds 1 while waiters are queued — indicates
     *   a double-unlock bug (more `unlock` calls than `lock` calls).
     */
    private unlock() {
        this.permits += 1;
        if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
            throw new Error('this.permits should never be > 0 when there is someone waiting.');
        } else if (this.permits === 1 && this.promiseResolverQueue.length > 0) {
            // WHY: Immediately re-consume the permit we just released so the
            // waiting caller's promise resolves with a valid lock grant.
            this.permits -= 1;

            const nextResolver = this.promiseResolverQueue.shift();
            // Resolve on the next tick to let the current call stack unwind first
            if (nextResolver) {
                setTimeout(() => {
                    nextResolver(true);
                }, 0);
            }
        }
    }
}
