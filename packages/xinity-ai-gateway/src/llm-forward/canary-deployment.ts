import { calcRolloutProgress, sql, inArray, deploymentCanaryT, type Deployment } from "common-db";
import { getDB } from "../db";
import { recordLbCanaryFallback, recordLbCanarySplit } from "../metrics";
import type { GatewayDeploymentType, ModelDescription } from "./deployment-types";
import type { ModelLookup } from "./model-data";
import { deriveStatus } from "./installations";
import { describeManagedRows, loadManagedRow, resolveManaged, type ManagedPayload } from "./managed-deployment";
import { orderByWeight } from "./weighted-targets";

export type CanaryPayload = {
  progress: number;
  canaryProgressFrom: number | null;
  canaryProgressUntil: number | null;
  from: ManagedPayload;
  to: ManagedPayload;
};

// Metric labels kept from the legacy canary, whose `final` side is the one traffic moves to.
const ROLE = { from: "early", to: "final" } as const;

function rolloutProgressOf(payload: Pick<CanaryPayload, "progress" | "canaryProgressFrom" | "canaryProgressUntil">): number {
  return calcRolloutProgress({
    progress: payload.progress,
    canaryProgressFrom: payload.canaryProgressFrom !== null ? new Date(payload.canaryProgressFrom) : null,
    canaryProgressUntil: payload.canaryProgressUntil !== null ? new Date(payload.canaryProgressUntil) : null,
  });
}

async function loadCanary(entry: Deployment): Promise<CanaryPayload | undefined> {
  if (!entry.canaryId) {
    return undefined;
  }
  const [canary] = await getDB().select().from(deploymentCanaryT)
    .where(sql`${deploymentCanaryT.id} = ${entry.canaryId}`)
    .limit(1);
  if (!canary) {
    return undefined;
  }
  const [from, to] = await Promise.all([loadManagedRow(canary.fromId), loadManagedRow(canary.toId)]);
  if (!from || !to) {
    return undefined;
  }
  return {
    progress: canary.progress,
    canaryProgressFrom: canary.canaryProgressFrom?.valueOf() ?? null,
    canaryProgressUntil: canary.canaryProgressUntil?.valueOf() ?? null,
    from,
    to,
  };
}

async function resolveCanary(payload: CanaryPayload, publicSpecifier: string, prefixHashes?: string[]): Promise<ModelLookup> {
  const progress = rolloutProgressOf(payload);
  const order = orderByWeight([
    { weight: 100 - progress, target: "from" as const },
    { weight: progress, target: "to" as const },
  ]);
  const drawn = order[0]!;
  recordLbCanarySplit(publicSpecifier, ROLE[drawn]);
  // A member with no ready installation gives way to the other, so a canary still downloading does not fail requests.
  for (const member of order) {
    const lookup = await resolveManaged(payload[member], publicSpecifier, prefixHashes);
    if (lookup.status !== "unavailable") {
      if (member !== drawn) {
        recordLbCanaryFallback(publicSpecifier, ROLE[drawn], ROLE[member]);
      }
      return lookup;
    }
  }
  return { status: "unavailable" };
}

async function describeCanary(entries: Deployment[]): Promise<Map<string, ModelDescription>> {
  const canaryIds = entries.flatMap((entry) => entry.canaryId ?? []);
  if (canaryIds.length === 0) {
    return new Map();
  }
  const canaries = await getDB().select().from(deploymentCanaryT).where(inArray(deploymentCanaryT.id, canaryIds));
  const members = await describeManagedRows(canaries.flatMap(({ fromId, toId }) => [fromId, toId]));
  const canaryById = new Map(canaries.map((canary) => [canary.id, canary]));

  return new Map(entries.flatMap((entry) => {
    const canary = entry.canaryId ? canaryById.get(entry.canaryId) : undefined;
    const from = canary && members.get(canary.fromId);
    const to = canary && members.get(canary.toId);
    if (!canary || !from || !to) {
      return [];
    }
    const progress = calcRolloutProgress(canary);
    const serving = [...(progress < 100 ? [from] : []), ...(progress > 0 ? [to] : [])];
    const description: ModelDescription = {
      status: deriveStatus([from.status, to.status].filter((status) => status !== null)),
      canary: progress !== 100,
      // A request can land on either serving member, so only the shorter context is safe to advertise.
      maxModelLen: Math.min(...serving.map(({ maxModelLen }) => maxModelLen)),
    };
    return [[entry.id, description] as const];
  }));
}

export const canaryDeployment: GatewayDeploymentType<CanaryPayload> = {
  load: loadCanary,
  resolve: resolveCanary,
  describe: describeCanary,
};
