import { describe, expect, it } from "bun:test";
import { burstFor, createRateLimiter, withRateLimit } from "./rate-limit";

const NOW = 1_700_000_000_000;
const MINUTE_MS = 60_000;

function fakeServer(address: string) {
  return { requestIP: () => ({ address }) };
}

describe("burstFor", () => {
  it("lets a client spend a full minute of allowance at once", () => {
    expect(burstFor(6)).toBe(6);
    expect(burstFor(600)).toBe(600);
  });

  it("never derives a burst of zero, which would deny every request", () => {
    expect(burstFor(1)).toBeGreaterThanOrEqual(1);
  });
});

describe("createRateLimiter", () => {
  it("allows a full burst then denies", () => {
    const limiter = createRateLimiter({ perMinute: 3 });
    expect(limiter.burst).toBe(3);

    expect(limiter.take("a", NOW)).toBe(true);
    expect(limiter.take("a", NOW)).toBe(true);
    expect(limiter.take("a", NOW)).toBe(true);
    expect(limiter.take("a", NOW)).toBe(false);
  });

  it("tracks clients independently", () => {
    const limiter = createRateLimiter({ perMinute: 1 });

    expect(limiter.take("a", NOW)).toBe(true);
    expect(limiter.take("a", NOW)).toBe(false);
    expect(limiter.take("b", NOW)).toBe(true);
  });

  it("refills at the sustained rate", () => {
    const limiter = createRateLimiter({ perMinute: 2 });
    const perToken = MINUTE_MS / 2;

    expect(limiter.take("a", NOW)).toBe(true);
    expect(limiter.take("a", NOW)).toBe(true);
    expect(limiter.take("a", NOW)).toBe(false);

    expect(limiter.take("a", NOW + perToken - 1)).toBe(false);
    expect(limiter.take("a", NOW + perToken)).toBe(true);
  });

  it("never refills beyond the burst", () => {
    const limiter = createRateLimiter({ perMinute: 2 });

    limiter.take("a", NOW);
    const hourLater = NOW + 3_600_000;

    expect(limiter.take("a", hourLater)).toBe(true);
    expect(limiter.take("a", hourLater)).toBe(true);
    expect(limiter.take("a", hourLater)).toBe(false);
  });

  it("refills a drained bucket completely within one minute", () => {
    const limiter = createRateLimiter({ perMinute: 4 });
    for (let spent = 0; spent < limiter.burst; spent++) {
      limiter.take("a", NOW);
    }
    expect(limiter.take("a", NOW)).toBe(false);

    for (let spent = 0; spent < limiter.burst; spent++) {
      expect(limiter.take("a", NOW + MINUTE_MS)).toBe(true);
    }
  });

  it("sweeps refilled buckets and keeps throttled ones", () => {
    const limiter = createRateLimiter({ perMinute: 2 });
    const perToken = MINUTE_MS / 2;

    limiter.take("idle", NOW);
    limiter.take("busy", NOW);
    limiter.take("busy", NOW);
    expect(limiter.size).toBe(2);

    limiter.sweep(NOW + perToken);
    expect(limiter.size).toBe(1);

    // Kept with its partial allowance, not reset: a fresh bucket would allow two.
    expect(limiter.take("busy", NOW + perToken)).toBe(true);
    expect(limiter.take("busy", NOW + perToken)).toBe(false);

    // Drained again at NOW + perToken, so full one minute after that.
    limiter.sweep(NOW + perToken + MINUTE_MS);
    expect(limiter.size).toBe(0);
  });

  it("derives Retry-After from the sustained rate", () => {
    expect(createRateLimiter({ perMinute: 6 }).retryAfterSeconds()).toBe(10);
    expect(createRateLimiter({ perMinute: 600 }).retryAfterSeconds()).toBe(1);
  });
});

describe("withRateLimit", () => {
  const ok = () => new Response("body");
  const keyOf = () => "client";

  it("passes through while under the ceiling", async () => {
    const handler = withRateLimit(createRateLimiter({ perMinute: 60 }), keyOf, ok);
    const res = await handler(new Request("http://localhost/"), fakeServer("10.0.0.1"));

    expect(res.status).toBe(200);
  });

  it("answers 429 with Retry-After once over it", async () => {
    const handler = withRateLimit(createRateLimiter({ perMinute: 1 }), keyOf, ok);
    const req = new Request("http://localhost/");
    const server = fakeServer("10.0.0.1");

    await handler(req, server);
    const res = await handler(req, server);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("does not invoke the handler when throttled", async () => {
    let calls = 0;
    const counted = () => {
      calls += 1;
      return new Response("body");
    };
    const handler = withRateLimit(createRateLimiter({ perMinute: 1 }), keyOf, counted);
    const req = new Request("http://localhost/");
    const server = fakeServer("10.0.0.1");

    await handler(req, server);
    await handler(req, server);

    expect(calls).toBe(1);
  });
});
