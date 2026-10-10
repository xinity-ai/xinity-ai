import { describe, expect, test } from "bun:test";
import { FakeHost, RUN_OK } from "../../helpers/fake-host.ts";
import { applyComponentAction } from "../../../src/lib/up/installer.ts";
import type { ComponentAction } from "../../../src/lib/up/up-plan.ts";
import { createSilentProgress } from "../../../src/lib/term/step-runner.ts";

const BIN_PATH = "/opt/xinity/bin/xinity-ai-gateway";

function updateAction(): ComponentAction {
  return {
    component: "gateway",
    kind: "update",
    installedVersion: "v1.0.0",
    toVersion: "v1.1.0",
    localArchivePath: "/build/gateway.tar.gz",
    env: { config: {}, secrets: {} },
    envChanges: [],
    secretFiles: { remove: [], keptForOtherComponents: [] },
    hardReset: true,
    serviceRunning: true,
  };
}

describe("applyComponentAction on an update", () => {
  test("leaves the binary and service alone when the artifact cannot be obtained", async () => {
    const host = new FakeHost({ run: (args) => (args[1] === "is-active" ? RUN_OK : undefined) });
    host.uploadFile = async () => { throw new Error("connection reset"); };

    const result = await applyComponentAction(updateAction(), host, createSilentProgress());

    expect(result.success).toBe(false);
    expect(host.calls.some((c) => c.includes(`mv -f ${BIN_PATH} `))).toBe(false);
    expect(host.calls.some((c) => c.includes("systemctl stop") || c.includes("systemctl clean"))).toBe(false);
  });

  test("restores the backed-up binary and restarts the hard-reset service when installing fails", async () => {
    const host = new FakeHost({
      run: (args) => (args[1] === "is-active" ? RUN_OK : undefined),
      withElevation: (cmd) => (cmd.includes(`cp `) && cmd.includes(` ${BIN_PATH}`) ? { success: false, output: "no space left" } : undefined),
    });

    const result = await applyComponentAction(updateAction(), host, createSilentProgress());

    expect(result.success).toBe(false);
    const backup = host.calls.findIndex((c) => c.includes(`mv -f ${BIN_PATH} ${BIN_PATH}.bak`));
    const stop = host.calls.findIndex((c) => c.includes("systemctl stop"));
    const restore = host.calls.findIndex((c) => c.includes(`mv -f ${BIN_PATH}.bak ${BIN_PATH}`));
    const start = host.calls.findIndex((c) => c.includes("systemctl enable --now"));
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(backup);
    expect(restore).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(restore);
  });
});
