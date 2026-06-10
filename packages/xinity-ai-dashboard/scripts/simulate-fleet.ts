/**
 * Live companion to seed-fleet: keeps the demo machines heartbeating so the
 * fleet page shows them online and visibly working. Every tick it refreshes
 * lastSeenAt, drifts GPU utilization, accumulates the current metric bucket,
 * and inserts a few usage events — watch the page update in real time.
 *
 * Usage: bun run simulate:fleet [minutes]   (default 30, requires seed:fleet first)
 */
import { join } from "path";
import { readFileSync } from "fs";
import {
  aiNodeT,
  nodeMetricT,
  organizationT,
  usageEventT,
  preconfigureDB,
  asc,
  eq,
  like,
  sql,
} from "common-db";

const DEMO_HOST_PREFIX = "demo-fleet-";
const TICK_MS = 10_000;
const BUCKET_MS = 5 * 60 * 1000;

/** Rough whole-machine power assumptions, matched by host name. */
const TDP_BY_HOST: [pattern: string, watts: number][] = [
  ["ascent", 100],
  ["rtx6000", 600],
  ["h100", 500],
];

function loadRootEnv() {
  if (process.env.DB_CONNECTION_URL) return;
  const envPath = join(import.meta.dir, "../../../.env");
  let text: string;
  try {
    text = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1).trim();
  }
}

/** Slow sine drift (~8 min period) plus jitter, phase-shifted per machine. */
function utilizationAt(nowMs: number, phase: number): number {
  const wave = Math.sin(nowMs / 480_000 + phase * 2.1) * 25;
  const jitter = (Math.random() - 0.5) * 10;
  return Math.min(98, Math.max(5, 45 + wave + jitter));
}

async function main() {
  loadRootEnv();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set and no root .env found");
  }
  const db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();

  const minutes = Number(process.argv[2]) || 30;
  const deadline = Date.now() + minutes * 60 * 1000;

  const [org] = await db.select().from(organizationT).orderBy(asc(organizationT.createdAt)).limit(1);
  if (!org) throw new Error("No organization found. Run bun run seed:fleet first.");

  const nodes = await db
    .select()
    .from(aiNodeT)
    .where(sql`${aiNodeT.host} LIKE ${`${DEMO_HOST_PREFIX}%`} AND ${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);
  if (nodes.length === 0) throw new Error("No demo fleet found. Run bun run seed:fleet first.");

  console.log(`Simulating ${nodes.length} online machines for ${minutes} minutes (Ctrl-C to stop)...`);

  while (Date.now() < deadline) {
    const now = Date.now();
    const bucketStart = new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS);

    for (const [index, node] of nodes.entries()) {
      const tdp = TDP_BY_HOST.find(([p]) => node.host.includes(p))?.[1] ?? 250;
      const utilization = utilizationAt(now, index);
      const watts = tdp * (0.1 + 0.9 * (utilization / 100));
      const energyDeltaWh = (watts * TICK_MS) / 3_600_000;

      await db
        .insert(nodeMetricT)
        .values({
          nodeId: node.id,
          bucketStart,
          gpuUtilizationAvg: utilization,
          gpuUtilizationMax: Math.min(100, utilization + 12),
          memoryUsedMb: Math.round((node.gpus[0]?.vramMb || 64_000) * (0.5 + utilization / 400)),
          powerWattsAvg: watts,
          energyWh: energyDeltaWh,
        })
        .onConflictDoUpdate({
          target: [nodeMetricT.nodeId, nodeMetricT.bucketStart],
          set: {
            gpuUtilizationAvg: utilization,
            gpuUtilizationMax: sql`greatest(${nodeMetricT.gpuUtilizationMax}, ${Math.min(100, utilization + 12)})`,
            powerWattsAvg: watts,
            energyWh: sql`${nodeMetricT.energyWh} + ${energyDeltaWh}`,
          },
        });

      await db
        .update(aiNodeT)
        .set({ lastSeenAt: new Date(now), totalEnergyWh: sql`${aiNodeT.totalEnergyWh} + ${energyDeltaWh}` })
        .where(eq(aiNodeT.id, node.id));

      const calls = Math.max(1, Math.round(utilization / 25));
      await db.insert(usageEventT).values(
        Array.from({ length: calls }, () => {
          const failed = Math.random() < 0.01;
          return {
            organizationId: org.id,
            model: "demo-live",
            nodeId: node.id,
            inputTokens: failed ? 0 : 400 + Math.floor(Math.random() * 3200),
            outputTokens: failed ? 0 : 80 + Math.floor(Math.random() * 900),
            duration: 300 + Math.floor(Math.random() * 4000),
            success: !failed,
          };
        }),
      );
    }

    process.stdout.write(".");
    await Bun.sleep(TICK_MS);
  }

  console.log("\nSimulation finished. Machines will drift offline after the heartbeat window.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
