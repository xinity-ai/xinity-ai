import { describe, test, expect, mock, beforeEach } from "bun:test";

const reportInstallationStates = mock(async () => true);

mock.module("../tether-client", () => ({ reportInstallationStates }));
mock.module("../statekeeper", () => ({ getNodeId: async () => "node-1" }));

// Other test files mock ./state for the whole run, and a query makes this import the module itself.
const { updateInstallationState } = (await import("./state.ts?unmocked" as string)) as typeof import("./state");

describe("updateInstallationState", () => {
  beforeEach(() => {
    reportInstallationStates.mockReset();
    reportInstallationStates.mockResolvedValue(true);
  });

  test("reports a state once, and again only when it changes", async () => {
    const waiting = { statusMessage: "Waiting for the other machines of its group", groupStage: "admitted" as const, groupGeneration: 1 };
    await updateInstallationState("unchanged", "installing", waiting);
    await updateInstallationState("unchanged", "installing", waiting);
    expect(reportInstallationStates).toHaveBeenCalledTimes(1);

    await updateInstallationState("unchanged", "installing", { ...waiting, groupStage: "running" });
    expect(reportInstallationStates).toHaveBeenCalledTimes(2);
  });

  test("reports a state again when the tether did not take it", async () => {
    reportInstallationStates.mockResolvedValueOnce(false);
    await updateInstallationState("retried", "downloading", { progress: 0.5 });
    await updateInstallationState("retried", "downloading", { progress: 0.5 });
    expect(reportInstallationStates).toHaveBeenCalledTimes(2);
  });
});
