import { describe, expect, it } from "bun:test";
import { CircuitBreaker } from "./circuit-breaker";

describe("CircuitBreaker", () => {
  it("starts in closed state and allows execution", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.currentState).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("transitions to open state after threshold failures", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    breaker.recordFailure();
    expect(breaker.currentState).toBe("closed");
    breaker.recordFailure();
    expect(breaker.currentState).toBe("closed");
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
    expect(breaker.canExecute()).toBe(false);
  });

  it("recovers to closed after success", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    expect(breaker.currentState).toBe("closed");
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.currentState).toBe("closed"); // counter was reset
  });

  it("transitions from open to half-open after reset timeout", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
    expect(breaker.canExecute()).toBe(false);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    expect(breaker.currentState).toBe("half-open");
    expect(breaker.canExecute()).toBe(true);

    // Success in half-open state closes the circuit
    breaker.recordSuccess();
    expect(breaker.currentState).toBe("closed");
  });

  it("re-opens if probe fails in half-open state", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");

    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.canExecute()).toBe(true);

    // Probe failure
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
    expect(breaker.canExecute()).toBe(false);
  });

  it("supports manual reset", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");
    breaker.reset();
    expect(breaker.currentState).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });
});
