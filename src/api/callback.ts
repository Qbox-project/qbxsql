/**
 * A CFX function reference invoked from JS returns a Promise for the invoking
 * runtime's completion of the call. When the caller's Lua continuation fails
 * after the callback resumes it, the failure is reported by the Lua runtime
 * and mirrored here as a rejection of that Promise; with no handler attached,
 * Node additionally prints an "Unhandled promise rejection" warning for an
 * error that was already delivered and handled. Attach a no-op handler so the
 * mirrored copy stays silent without changing what the caller observes.
 */
export function detachCallbackResult(value: unknown): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  ) {
    void Promise.resolve(value as PromiseLike<unknown>).then(undefined, () => {});
  }
}
