import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { DesiredState } from "common-env";

mock.module("./logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

const { createNotifyBus, CHANNEL } = await import("./notify-bus");

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  const connected = new Set<string>();
  const pushed: string[] = [];
  const built: string[] = [];
  const channels: string[] = [];
  let onNotify: ((payload: string) => void) | undefined;
  let onSubscribed: (() => void) | undefined;
  let unlistenCalls = 0;

  const bus = createNotifyBus({
    subscribe: (channel, notify, subscribed) => {
      channels.push(channel);
      onNotify = notify;
      onSubscribed = subscribed;
      return Promise.resolve(() => {
        unlistenCalls += 1;
        return Promise.resolve();
      });
    },
    buildDesiredState: (nodeId: string): Promise<DesiredState> => {
      built.push(nodeId);
      return Promise.resolve({ nodeId, installations: [] });
    },
    pushDesiredState: (nodeId: string) => {
      pushed.push(nodeId);
      return true;
    },
    isConnected: (nodeId: string) => connected.has(nodeId),
    getConnectedNodeIds: () => [...connected],
  });

  return {
    bus,
    connected,
    pushed,
    built,
    channels,
    notify: (payload: string) => onNotify!(payload),
    resubscribe: () => onSubscribed!(),
    unlistenCalls: () => unlistenCalls,
  };
}

function afterCoalesceWindow(): Promise<void> {
  return Bun.sleep(250);
}

let h: Harness;

describe("notify-bus", () => {
  beforeEach(() => {
    h = makeHarness();
  });

  test("one subscription serves every connected node", async () => {
    h.connected.add("node-a");
    h.connected.add("node-b");
    h.connected.add("node-c");

    await h.bus.start();

    expect(h.channels).toEqual([CHANNEL]);
    await h.bus.stop();
  });

  test("repeated notifications for one node collapse into a single push", async () => {
    h.connected.add("node-1");
    await h.bus.start();

    h.notify("node-1");
    h.notify("node-1");
    h.notify("node-1");
    await afterCoalesceWindow();

    expect(h.built).toEqual(["node-1"]);
    expect(h.pushed).toEqual(["node-1"]);
    await h.bus.stop();
  });

  test("re-establishing the subscription re-syncs every live daemon", async () => {
    h.connected.add("node-a");
    h.connected.add("node-b");
    await h.bus.start();

    h.resubscribe();
    await afterCoalesceWindow();

    expect(h.pushed.toSorted()).toEqual(["node-a", "node-b"]);
    await h.bus.stop();
  });

  test("a notification for a node that is not connected costs no query", async () => {
    await h.bus.start();

    h.notify("node-gone");
    await afterCoalesceWindow();

    expect(h.built).toEqual([]);
    expect(h.pushed).toEqual([]);
    await h.bus.stop();
  });

  test("stopping unlistens and drops work queued but not yet flushed", async () => {
    h.connected.add("node-1");
    await h.bus.start();

    h.notify("node-1");
    await h.bus.stop();
    await afterCoalesceWindow();

    expect(h.unlistenCalls()).toBe(1);
    expect(h.pushed).toEqual([]);
  });
});
