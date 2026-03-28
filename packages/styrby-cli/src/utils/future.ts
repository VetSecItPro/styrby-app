/**
 * A deferred promise wrapper that exposes resolve/reject externally.
 *
 * Useful when you need to resolve or reject a promise from outside
 * the executor function — for example, when waiting for an async event
 * to complete before continuing.
 *
 * @template T - The resolved value type
 */
export class Future<T> {
    private _resolve!: (value: T) => void;
    private _reject!: (reason?: unknown) => void;
    private _promise: Promise<T>;

    constructor() {
        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    /**
     * Resolve the future with a value.
     *
     * @param value - The resolved value
     */
    resolve(value: T) {
        this._resolve(value);
    }

    /**
     * Reject the future with a reason.
     *
     * @param reason - The rejection reason (typically an Error)
     */
    reject(reason?: unknown) {
        this._reject(reason);
    }

    /** The underlying promise */
    get promise() {
        return this._promise;
    }
}