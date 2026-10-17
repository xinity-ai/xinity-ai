import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { aiNodeT, inArray, modelDeploymentT, modelInstallationT, organizationT, preconfigureDB, sql } from "common-db";
import { GROUP_RESTART_BUDGET, type GroupStage, type InstallationGroup } from "common-env";
import { getAvailablePort } from "../test-helpers";
import { ensureSystemReady } from "../guard";

const { getDB } = preconfigureDB(process.env.DB_CONNECTION_URL!);
const db = getDB();

process.env.TETHER_SECRET ??= "system-test-secret";
process.env.LOG_LEVEL ??= "warn";
const { flushAndStop, queueInstallationStates } = await import("../../../packages/xinity-tether/src/status-writer");
const { buildDesiredState } = await import("../../../packages/xinity-tether/src/desired-state");

const organizationId = `org-${randomUUID()}`;
const nodeIds = [randomUUID(), randomUUID()];
let deploymentId: string;
let installationIds: string[] = [];
let groupId: string;

const groupOf = (rank: number): InstallationGroup => ({
  id: groupId,
  rank,
  size: 2,
  rendezvousPort: 29500,
  generation: 1,
  addresses: [{ subnet: "192.168.100.0/24", address: `192.168.100.${254 - rank}` }],
});

async function report(rank: number, groupStage: GroupStage, groupGeneration: number): Promise<void> {
  queueInstallationStates([{
    installationId: installationIds[rank]!,
    lifecycleState: groupStage === "failed" ? "failed" : "installing",
    groupStage,
    groupGeneration,
  }]);
  await flushAndStop();
}

async function generations(): Promise<number[]> {
  const rows = await db.select({ group: modelInstallationT.group }).from(modelInstallationT).where(inArray(modelInstallationT.id, installationIds));
  return rows.map(({ group }) => group!.generation);
}

async function setGeneration(generation: number): Promise<void> {
  await db.update(modelInstallationT)
    .set({ group: sql`jsonb_set(${modelInstallationT.group}, '{generation}', to_jsonb(${generation}::int))` })
    .where(inArray(modelInstallationT.id, installationIds));
}

beforeAll(async () => {
  await ensureSystemReady();
  await db.insert(organizationT).values({ id: organizationId, name: "Tether Group Tests", slug: `tether-group-tests-${randomUUID()}` });
  const [deployment] = await db.insert(modelDeploymentT).values({
    organizationId,
    name: "Tether Group Test Model",
    publicSpecifier: `group-model-${randomUUID()}`,
    specifier: "group-model",
  }).returning();
  deploymentId = deployment!.id;
  for (const id of nodeIds) {
    await db.insert(aiNodeT).values({ id, host: "127.0.0.1", port: await getAvailablePort(), estCapacity: 100, available: true });
  }
});

afterAll(async () => {
  await db.delete(modelDeploymentT).where(sql`${modelDeploymentT.id} = ${deploymentId}`);
  await db.update(aiNodeT).set({ deletedAt: new Date() }).where(inArray(aiNodeT.id, nodeIds));
  await db.delete(organizationT).where(sql`${organizationT.id} = ${organizationId}`);
});

describe("tether: restarting a group served across nodes", () => {
  async function placeGroup(): Promise<void> {
    groupId = randomUUID();
    const rows = await db.insert(modelInstallationT).values(nodeIds.map((nodeId, rank) => ({
      nodeId,
      deploymentId,
      specifier: "group-model",
      estCapacity: 30,
      port: 9000 + rank,
      driver: "vllm" as const,
      group: groupOf(rank),
    }))).returning();
    installationIds = rows.map((row) => row.id);
  }

  it("restarts the whole group once when both members fail the same attempt", async () => {
    await placeGroup();
    queueInstallationStates(installationIds.map((installationId) => ({ installationId, lifecycleState: "failed" as const, groupStage: "failed" as const, groupGeneration: 1 })));
    await flushAndStop();
    expect(await generations()).toEqual([2, 2]);
  });

  it("ignores a failure from an attempt the group has left", async () => {
    await placeGroup();
    await setGeneration(2);
    await report(1, "failed", 1);
    expect(await generations()).toEqual([2, 2]);
  });

  it("stops restarting once the group used its restart budget", async () => {
    await placeGroup();
    await setGeneration(GROUP_RESTART_BUDGET + 1);
    await report(0, "failed", GROUP_RESTART_BUDGET + 1);
    expect(await generations()).toEqual([GROUP_RESTART_BUDGET + 1, GROUP_RESTART_BUDGET + 1]);
  });

  it("hands every member the stage and attempt of each member, and rank 0's addresses to meet at", async () => {
    await placeGroup();
    await report(0, "admitted", 1);
    await report(1, "preparing", 1);
    const desired = await buildDesiredState(nodeIds[1]!);
    const group = desired.installations.find((installation) => installation.installationId === installationIds[1])!.group!;
    expect(group.members).toEqual([{ rank: 0, stage: "admitted", generation: 1 }, { rank: 1, stage: "preparing", generation: 1 }]);
    expect(group.masterAddresses).toEqual([{ subnet: "192.168.100.0/24", address: "192.168.100.254" }]);
  });
});
