import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { UnsignedInstallationStateReport } from "common-env";

const reportInstallationStates = mock(async (_report: UnsignedInstallationStateReport) => true);

mock.module("../tether-client", () => ({ reportInstallationStates }));
mock.module("../statekeeper", () => ({ getNodeId: async () => "node-1" }));

// Other test files mock ./state for the whole run, and a query makes this import the module itself.
const { updateInstallationState, reportUnacceptedStates } = (await import("./state.ts?unmocked" as string)) as typeof import("./state");

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

  test("a sync re-sends a state the tether did not take, and only that one", async () => {
    await updateInstallationState("taken", "ready");
    reportInstallationStates.mockResolvedValueOnce(false);
    await updateInstallationState("lost", "ready");
    reportInstallationStates.mockClear();

    await reportUnacceptedStates(["taken", "lost"]);
    expect(reportInstallationStates).toHaveBeenCalledTimes(1);
    expect(reportInstallationStates.mock.calls[0]).toMatchObject([{ states: [{ installationId: "lost", lifecycleState: "ready" }] }]);

    await reportUnacceptedStates(["taken", "lost"]);
    expect(reportInstallationStates).toHaveBeenCalledTimes(1);
  });

  test("an older state never lands after a newer one", async () => {
    const sent: string[] = [];
    const firstInFlight = Promise.withResolvers<void>();
    const firstReleased = Promise.withResolvers<void>();
    reportInstallationStates.mockImplementationOnce(async ({ states }) => {
      firstInFlight.resolve();
      await firstReleased.promise;
      sent.push(states[0]!.lifecycleState);
      return true;
    });
    reportInstallationStates.mockImplementation(async ({ states }) => {
      sent.push(states[0]!.lifecycleState);
      return true;
    });

    const installing = updateInstallationState("ordered", "installing");
    await firstInFlight.promise;
    const ready = updateInstallationState("ordered", "ready");
    firstReleased.resolve();
    await Promise.all([installing, ready]);
    expect(sent).toEqual(["installing", "ready"]);
  });
});
