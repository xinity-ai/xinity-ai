import { describe, expect, mock, test } from "bun:test";
import type { ModelInstallation } from "common-db";
import type { InstallationGroup } from "common-env";

mock.module("./db", () => ({ getDB: () => ({}) }));
mock.module("./logger", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const { toDesiredState } = await import("./desired-state");

const row = (id: string, nodeId: string, group: InstallationGroup | null = null): ModelInstallation => ({
  id, nodeId, deploymentId: "dep-1", specifier: "big", estCapacity: 40, kvCacheCapacity: 8, hostCapacity: 8, maxNumSeqs: 16,
  port: 11435, driver: "vllm", settings: { version: 1 }, gpuIds: [], group,
  deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
});
const member = (rank: number, address: string): InstallationGroup => ({
  id: "group-1", rank, size: 2, rendezvousPort: 29500, addresses: [{ subnet: "192.168.100.0/24", address }], generation: 1,
});

describe("toDesiredState", () => {
  test("gives every member of a group rank 0's addresses to meet at and how far each member is", () => {
    const leader = row("m0", "node-a", member(0, "192.168.100.254"));
    const follower = row("m1", "node-b", member(1, "192.168.100.253"));
    const [installation] = toDesiredState("node-b", [follower], [{ ...follower, stage: "preparing", stageGeneration: 1 }, { ...leader, stage: "admitted", stageGeneration: 1 }]).installations;
    expect(installation!.group).toEqual({
      ...member(1, "192.168.100.253"),
      masterAddresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.254" }],
      members: [{ rank: 0, stage: "admitted", generation: 1 }, { rank: 1, stage: "preparing", generation: 1 }],
    });
  });

  test("leaves out a member whose group has no rank 0, and keeps single installations as they are", () => {
    const orphan = row("m1", "node-b", member(1, "192.168.100.253"));
    const single = row("s1", "node-b");
    const { installations } = toDesiredState("node-b", [orphan, single], [{ ...orphan, stage: null, stageGeneration: null }]);
    expect(installations.map((installation) => [installation.installationId, installation.group])).toEqual([["s1", null]]);
  });
});
