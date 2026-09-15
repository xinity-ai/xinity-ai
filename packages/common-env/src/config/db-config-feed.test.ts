import { describe, expect, test } from "bun:test";
import { createDbConfigFeed } from "./db-config-feed";

const COALESCE_MS = 200;
const RETRY_MS = 1_000;
const RECONCILE_MS = 30;
const SETTLE_MS = 20;

function makeHarness(
  opts: { read?: () => Promise<Record<string, string>>; reconcileIntervalMs?: number } = {},
) {
  const applied: Array<Record<string, string>> = [];
  const errors: object[] = [];
  const warnings: object[] = [];
  let onNotify: ((payload: string) => void) | undefined;
  let onSubscribed: (() => void) | undefined;
  let reads = 0;
  let applyThrows: Error | null = null;
  let teardown: (() => Promise<void>) | null = null;

  const feed = createDbConfigFeed({
    channel: "dynamic_config",
    reconcileIntervalMs: opts.reconcileIntervalMs,
    read: () => {
      reads += 1;
      return opts.read?.() ?? Promise.resolve({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    },
    subscribe: (_channel, notify, subscribed) => {
      onNotify = notify;
      onSubscribed = subscribed;
      return Promise.resolve(() => Promise.resolve());
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: (obj) => warnings.push(obj),
      error: (obj) => errors.push(obj),
    },
  });

  return {
    applied,
    errors,
    warnings,
    get reads() {
      return reads;
    },
    failApply(err: Error) {
      applyThrows = err;
    },
    async start() {
      teardown = await feed((overrides) => {
        if (applyThrows) {
          throw applyThrows;
        }
        applied.push(overrides);
        return Object.keys(overrides);
      });
    },
    async stop() {
      await teardown?.();
    },
    notify: () => onNotify?.("RESPONSE_CACHE_TTL_SECONDS"),
    resubscribe: () => onSubscribed?.(),
  };
}

async function advancePast(timerMs: number): Promise<void> {
  await Bun.sleep(timerMs + SETTLE_MS);
}

describe("createDbConfigFeed", () => {
  test("loads the current values whenever the subscription is established", async () => {
    const h = makeHarness();
    await h.start();
    h.resubscribe();
    await advancePast(COALESCE_MS);

    expect(h.applied).toEqual([{ RESPONSE_CACHE_TTL_SECONDS: "60" }]);
    await h.stop();
  });

  test("coalesces a burst of notifications into one read", async () => {
    const h = makeHarness();
    await h.start();
    h.notify();
    h.notify();
    h.notify();
    await advancePast(COALESCE_MS);

    expect(h.reads).toBe(1);
    await h.stop();
  });

  test("retries after a failed read", async () => {
    let attempt = 0;
    const h = makeHarness({
      read: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error("connection refused"))
          : Promise.resolve({ RESPONSE_CACHE_TTL_SECONDS: "60" });
      },
    });
    await h.start();
    h.notify();
    await advancePast(COALESCE_MS);
    expect(h.applied).toEqual([]);

    await advancePast(RETRY_MS);
    expect(h.applied).toEqual([{ RESPONSE_CACHE_TTL_SECONDS: "60" }]);
    await h.stop();
  });

  test("does not retry a value the declaration rejects", async () => {
    const h = makeHarness();
    h.failApply(new Error("must be a whole number"));
    await h.start();
    h.notify();
    await advancePast(COALESCE_MS);

    await advancePast(RETRY_MS);
    expect(h.reads).toBe(1);
    expect(h.errors).toHaveLength(1);
    await h.stop();
  });

  test("a notification during an in-flight read is served by a later read, not a racing one", async () => {
    let release: (() => void) | undefined;
    let attempt = 0;
    const h = makeHarness({
      read: () => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<Record<string, string>>((resolve) => {
            release = () => resolve({ RESPONSE_CACHE_TTL_SECONDS: "stale" });
          });
        }
        return Promise.resolve({ RESPONSE_CACHE_TTL_SECONDS: "fresh" });
      },
    });
    await h.start();
    h.notify();
    await advancePast(COALESCE_MS);

    h.notify();
    release?.();
    await advancePast(COALESCE_MS);

    expect(h.applied.at(-1)).toEqual({ RESPONSE_CACHE_TTL_SECONDS: "fresh" });
    await h.stop();
  });

  test("reconciles on an interval and warns about the drift it finds", async () => {
    const h = makeHarness({ reconcileIntervalMs: RECONCILE_MS });
    await h.start();
    await advancePast(RECONCILE_MS);

    expect(h.reads).toBeGreaterThan(0);
    expect(h.warnings).not.toBeEmpty();
    await h.stop();
  });

  test("stops refreshing and reconciling once torn down", async () => {
    const h = makeHarness({ reconcileIntervalMs: RECONCILE_MS });
    await h.start();
    h.notify();
    await h.stop();
    await advancePast(RECONCILE_MS * 2);

    expect(h.reads).toBe(0);
  });
});
