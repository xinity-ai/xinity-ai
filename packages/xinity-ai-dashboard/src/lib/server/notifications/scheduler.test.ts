import { describe, test, expect } from "bun:test";
import { NotificationType } from "./events";

const { noticeOnChange } = await import("./scheduler");

describe("noticeOnChange", () => {
  test("alerts when a rollout loses one side", () => {
    expect(noticeOnChange("ready", "degraded")?.type).toBe(NotificationType.deployment_degraded);
  });

  test("names the model of the rollout that has no serving replica", () => {
    const notice = noticeOnChange("downloading", "degraded")!;
    const data = notice.data({
      phase: "degraded",
      progress: null,
      wanted: [{ specifier: "new-model", side: "to", replicas: 1 }, { specifier: "old-model", side: "from", replicas: 1 }],
      replicas: [
        { phase: "failed", specifier: "new-model", side: "to", node: "node-0", error: "boom" },
        { phase: "ready", specifier: "old-model", side: "from", node: "node-1", error: null },
      ],
    });
    expect(data.notServing).toEqual(["new-model"]);
  });

  test("names a side with no machine at all as not serving", () => {
    const data = noticeOnChange("ready", "degraded")!.data({
      phase: "degraded",
      progress: null,
      wanted: [{ specifier: "new-model", side: "to", replicas: 1 }, { specifier: "old-model", side: "from", replicas: 1 }],
      replicas: [{ phase: "ready", specifier: "old-model", side: "from", node: "node-1", error: null }],
    });
    expect(data.notServing).toEqual(["new-model"]);
  });

  test("alerts when a deployment goes down", () => {
    expect(noticeOnChange("ready", "down")?.type).toBe(NotificationType.deployment_down);
  });

  test("alerts when a deployment fails", () => {
    expect(noticeOnChange("installing", "failed")?.type).toBe(NotificationType.deployment_failed);
  });

  test("never alerts about a deployment short of replicas", () => {
    expect(noticeOnChange("ready", "partial")).toBeUndefined();
    expect(noticeOnChange("partial", "ready")).toBeUndefined();
  });

  test("reports ready once a deployment starts serving, even short of replicas", () => {
    expect(noticeOnChange("downloading", "ready")?.type).toBe(NotificationType.deployment_ready);
    expect(noticeOnChange("scheduling", "partial")?.type).toBe(NotificationType.deployment_ready);
  });

  test("reports ready when a degraded or down deployment serves as configured again", () => {
    expect(noticeOnChange("degraded", "ready")?.type).toBe(NotificationType.deployment_ready);
    expect(noticeOnChange("down", "partial")?.type).toBe(NotificationType.deployment_ready);
  });

  test("stays quiet while a phase holds or a deployment is on its way", () => {
    expect(noticeOnChange("degraded", "degraded")).toBeUndefined();
    expect(noticeOnChange("pending", "downloading")).toBeUndefined();
    expect(noticeOnChange("ready", "installing")).toBeUndefined();
  });
});
