/**
 * Lightweight circuit breaker for external service calls.
 *
 * States:
 *   closed    → Normal operation, requests pass through.
 *   open      → Too many failures, requests are short-circuited.
 *   half-open → After the reset timeout, one probe request is allowed.
 *
 * Thread-safe for single-threaded runtimes (Bun/Node).
 */

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Milliseconds to stay in open state before transitioning to half-open. Default: 30_000. */
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
  }

  /** Current circuit state. */
  get currentState(): CircuitBreakerState {
    if (this.state === "open" && this.shouldAttemptReset()) {
      return "half-open";
    }
    return this.state;
  }

  /** Returns true if the request should be allowed through. */
  canExecute(): boolean {
    const effective = this.currentState;
    if (effective === "closed") return true;
    if (effective === "half-open") {
      // Transition to half-open; allow a single probe request
      this.state = "half-open";
      return true;
    }
    // open
    return false;
  }

  /** Call after a successful request. Resets the breaker to closed. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  /** Call after a failed request. Opens the breaker once the threshold is reached. */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  /** Force-reset the breaker to closed state. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.openedAt >= this.resetTimeoutMs;
  }
}
