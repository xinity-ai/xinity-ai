import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

const { createCacheInvalidation } = await import("./cache-invalidation");

function makeHarness() {
  const handlers = new Map<string, { notify: (payload: string) => void; resubscribed: () => void }>();
  const sourceFlushes: string[] = [];
  const deploymentFlushes: string[] = [];
  let unlistenCalls = 0;

  const invalidation = createCacheInvalidation({
    subscribe: (channel, onNotify, onSubscribed) => {
      handlers.set(channel, { notify: onNotify, resubscribed: onSubscribed! });
      return Promise.resolve(() => {
        unlistenCalls += 1;
        return Promise.resolve();
      });
    },
    invalidateModelSources: () => {
      sourceFlushes.push("sources");
    },
    invalidateDeployments: () => {
      deploymentFlushes.push("deployments");
      return Promise.resolve();
    },
  });

  return {
    invalidation,
    channels: () => [...handlers.keys()],
    notify: (channel: string, payload = "id") => handlers.get(channel)!.notify(payload),
    resubscribe: (channel: string) => handlers.get(channel)!.resubscribed(),
    sourceFlushes,
    deploymentFlushes,
    unlistenCalls: () => unlistenCalls,
  };
}

let h: ReturnType<typeof makeHarness>;

describe("cache-invalidation", () => {
  beforeEach(() => {
    h = makeHarness();
  });

  test("subscribes to every table the caches are derived from", async () => {
    await h.invalidation.start();

    expect(h.channels()).toEqual([
      "ai_node",
      "model_installation",
      "model_installation_state",
      "model_deployment",
    ]);
    await h.invalidation.stop();
  });

  test("a change to any routing table drops the model sources", async () => {
    await h.invalidation.start();

    h.notify("ai_node");
    h.notify("model_installation");
    h.notify("model_installation_state");

    expect(h.sourceFlushes).toHaveLength(3);
    expect(h.deploymentFlushes).toHaveLength(0);
    await h.invalidation.stop();
  });

  test("a deployment change drops the deployment cache and nothing else", async () => {
    await h.invalidation.start();

    h.notify("model_deployment");

    expect(h.deploymentFlushes).toHaveLength(1);
    expect(h.sourceFlushes).toHaveLength(0);
    await h.invalidation.stop();
  });

  test("re-subscribing drops what that channel feeds, since its notifications were missed", async () => {
    await h.invalidation.start();

    h.resubscribe("model_installation");
    h.resubscribe("model_deployment");

    expect(h.sourceFlushes).toHaveLength(1);
    expect(h.deploymentFlushes).toHaveLength(1);
    await h.invalidation.stop();
  });

  test("stopping unlistens every subscription exactly once", async () => {
    await h.invalidation.start();
    await h.invalidation.stop();
    await h.invalidation.stop();

    expect(h.unlistenCalls()).toBe(4);
  });
});
