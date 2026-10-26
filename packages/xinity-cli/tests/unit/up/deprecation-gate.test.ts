import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentAction } from "../../../src/lib/up/up-plan.ts";
import { FakeHost } from "../../helpers/fake-host.ts";

let answer = true;
const confirm = mock(async () => answer);
const realClack = await import("../../../src/lib/core/clack.ts");
mock.module("../../../src/lib/core/clack.ts", () => ({ ...realClack, confirm }));

const { deprecationGate } = await import("../../../src/lib/up/deprecation-gate.ts");

const LEGACY_CALLS = { id: "dashboard.legacy-api-calls", removedIn: "0.30.0", message: "12 API calls are still in the legacy table." };

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ ok: true, checks: {}, deprecations: [LEGACY_CALLS] }),
});
afterAll(() => server.stop(true));

function update(overrides: Partial<ComponentAction> = {}): ComponentAction {
  return {
    component: "gateway",
    kind: "update",
    installedVersion: "v0.29.0",
    toVersion: "v0.30.0",
    serviceRunning: true,
    env: { config: { HOST: "127.0.0.1", PORT: String(server.port) }, secrets: { METRICS_AUTH: "ops:secret" } },
    ...overrides,
  } as ComponentAction;
}

const gate = (actions: ComponentAction[], dryRun = false) =>
  deprecationGate(actions.map((action) => ({ host: new FakeHost(), action })), { dryRun });

beforeEach(() => {
  confirm.mockClear();
  answer = true;
});

describe("deprecationGate", () => {
  test("stops when the operator declines an update that removes something still in use", async () => {
    answer = false;

    expect(await gate([update()])).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("continues when the operator confirms", async () => {
    expect(await gate([update()])).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("asks once for a deprecation every updated service reports", async () => {
    expect(await gate([update(), update({ component: "tether" })])).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("does not ask when the update stays below the removal version", async () => {
    expect(await gate([update({ toVersion: "v0.29.5" })])).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("lists but never asks in a dry run", async () => {
    expect(await gate([update()], true)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("a service it cannot read is not counted as clean, but does not block on its own", async () => {
    expect(await gate([update({ env: { config: { PORT: String(server.port) }, secrets: {} } })])).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("ignores installs, unchanged versions and stopped services", async () => {
    const skipped = [
      update({ kind: "install", installedVersion: undefined }),
      update({ installedVersion: "v0.30.0" }),
      update({ serviceRunning: false }),
    ];

    expect(await gate(skipped)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
