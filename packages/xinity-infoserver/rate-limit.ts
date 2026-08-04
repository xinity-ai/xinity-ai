/**
 * Per-client token buckets. The reverse proxy in front does the coarse limiting, but
 * it cannot know that a full-catalog export costs orders of magnitude more than a
 * single lookup, so the asymmetric ceiling lives here.
 */
import type { SocketAddressSource } from "./client-ip";

type BucketState = { tokens: number; lastRefillMs: number };

/**
 * How much of the sustained allowance a client may spend at once, in minutes. At 1
 * nobody is rejected whose one-minute total is within budget, however unevenly it
 * arrived. Above 1 they could borrow against future minutes.
 */
const BURST_WINDOW_MINUTES = 1;

export interface RateLimiterConfig {
  perMinute: number;
}

/** Requests a client may make back to back, derived so it can't be tuned apart from the rate. */
export function burstFor(perMinute: number): number {
  return Math.max(1, Math.round(perMinute * BURST_WINDOW_MINUTES));
}

export interface RateLimiter {
  /** Consumes one token. Returns false when the client is over its ceiling. */
  take(key: string, nowMs?: number): boolean;
  /** Drops fully-refilled buckets so idle clients can't grow the map without bound. */
  sweep(nowMs?: number): void;
  retryAfterSeconds(): number;
  readonly burst: number;
  readonly size: number;
}

export type RouteHandler = (req: Request, server: SocketAddressSource) => Response | Promise<Response>;

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const buckets = new Map<string, BucketState>();
  const refillPerMs = config.perMinute / 60_000;
  const burst = burstFor(config.perMinute);

  function refilled(bucket: BucketState, nowMs: number): number {
    return Math.min(burst, bucket.tokens + (nowMs - bucket.lastRefillMs) * refillPerMs);
  }

  return {
    take(key: string, nowMs = Date.now()): boolean {
      const bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, { tokens: burst - 1, lastRefillMs: nowMs });
        return true;
      }

      bucket.tokens = refilled(bucket, nowMs);
      bucket.lastRefillMs = nowMs;
      if (bucket.tokens < 1) {
        return false;
      }
      bucket.tokens -= 1;
      return true;
    },

    sweep(nowMs = Date.now()): void {
      for (const [key, bucket] of buckets) {
        if (refilled(bucket, nowMs) >= burst) {
          buckets.delete(key);
        }
      }
    },

    retryAfterSeconds(): number {
      return Math.max(1, Math.ceil(60 / config.perMinute));
    },

    burst,

    get size(): number {
      return buckets.size;
    },
  };
}

export function withRateLimit(
  limiter: RateLimiter,
  keyOf: (req: Request, server: SocketAddressSource) => string,
  handler: RouteHandler,
): RouteHandler {
  return (req, server) => {
    if (limiter.take(keyOf(req, server))) {
      return handler(req, server);
    }
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(limiter.retryAfterSeconds()) },
    });
  };
}
