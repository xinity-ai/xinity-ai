import type { ClientResult, NemotronConfig } from "./types";
import { CircuitBreaker } from "./circuit-breaker";

export type NemotronFetch = typeof fetch;

export class NemotronClient {
  private readonly config: NemotronConfig;
  private readonly fetchImpl: NemotronFetch;
  private readonly breaker: CircuitBreaker;

  constructor(config: NemotronConfig, fetchImpl?: NemotronFetch) {
    this.config = config;
    this.fetchImpl = fetchImpl ?? fetch;
    this.breaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    });
  }

  get isEnabled(): boolean {
    return Boolean(this.config.enabled && this.config.endpoint);
  }

  /** Expose circuit breaker state for metrics / diagnostics. */
  get circuitState() {
    return this.breaker.currentState;
  }

  async post<TReq, TRes>(path: string, body: TReq, timeoutMs = 3000): Promise<ClientResult<TRes>> {
    if (!this.isEnabled) {
      return { status: "skipped", reason: "disabled" };
    }

    if (!this.breaker.canExecute()) {
      return { status: "skipped", reason: "circuit_open" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = new URL(path, this.config.endpoint).toString();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        this.breaker.recordFailure();
        return { status: "skipped", reason: "error" };
      }

      const data = (await res.json()) as TRes;
      this.breaker.recordSuccess();
      return { status: "success", data };
    } catch (err) {
      this.breaker.recordFailure();
      if (err instanceof DOMException && err.name === "AbortError") {
        return { status: "skipped", reason: "timeout" };
      }
      return { status: "skipped", reason: "error" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

