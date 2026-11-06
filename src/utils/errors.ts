/**
 * src/utils/errors.ts
 */

export class AppError extends Error {
  httpStatus: number;

  constructor(httpStatus: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.httpStatus = httpStatus;
    this.name = "AppError";
  }
}

/**
 * Control-flow error for cooperative cancellation. `name = "AbortError"`
 * matches what fetch throws on an aborted signal, so existing catch blocks
 * that branch on `err.name === "AbortError"` (e.g. runDiscovery's terminal
 * handler) treat both identically — the run counts as aborted, not errored.
 */
export class DiscoveryAbortError extends Error {
  constructor(message = "Discovery aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * Throw DiscoveryAbortError when `signal` has fired. Sprinkled at phase
 * boundaries in long non-HTTP work (DB sync passes) so an operator cancel
 * interrupts between phases — HTTP transports already observe the signal
 * natively, this covers the awaits that don't.
 */
export function throwIfAborted(signal: AbortSignal | undefined, context?: string): void {
  if (signal?.aborted) {
    throw new DiscoveryAbortError(context ? `Discovery aborted before ${context}` : undefined);
  }
}
