/**
 * Seeds a demo compute fleet for local UI development: 3 Ascent GX10, 2 RTX PRO
 * 6000, and 1 H100 node with 24h of metrics and usage events. Re-runnable; all
 * demo rows are keyed by the DEMO_HOST_PREFIX and replaced on each run.
 *
 * Usage: bun run seed:fleet  (requires docker compose db + at least one org)
 */
import { join } from "path";
import { readFileSync } from "fs";
import {
  aiNodeT,
  modelInstallationT,
  modelInstallationStateT,
  nodeMetricT,
  organizationT,
  usageEventT,
  preconfigureDB,
  asc,
  eq,
  inArray,
  like,
} from "common-db";

const DEMO_HOST_PREFIX = "demo-fleet-";
const HOURS = 24;
const BUCKET_MS = 5 * 60 * 1000;

type DemoMachine = {
  host: string;
  machineName: string;
  gpus: { vendor: string; name: string; vramMb: number }[];
  estCapacity: number;
  tdpWatts: number;
  /** Mean utilization the generated day oscillates around. */
  baseUtilization: number;
  models: { specifier: string; model: string; driver: "ollama" | "vllm"; estCapacity: number }[];
  online: boolean;
};

const MACHINES: DemoMachine[] = [
  ...[1, 2, 3].map((i) => ({
    host: `${DEMO_HOST_PREFIX}ascent-0${i}`,
    machineName: "Ascent GX10",
    gpus: [{ vendor: "nvidia", name: "NVIDIA GB10", vramMb: 0 }],
    estCapacity: 110,
    tdpWatts: 100,
    baseUtilization: 35 + i * 8,
    models: [
      { specifier: "qwen3:8b", model: "qwen3:8b", driver: "ollama" as const, estCapacity: 8 },
      { specifier: "nomic-embed-text", model: "nomic-embed-text", driver: "ollama" as const, estCapacity: 1 },
    ],
    online: i !== 3, // one machine offline to exercise that UI state
  })),
  ...[1, 2].map((i) => ({
    host: `${DEMO_HOST_PREFIX}rtx6000-0${i}`,
    machineName: "RTX PRO 6000 Workstation",
    gpus: [{ vendor: "nvidia", name: "NVIDIA RTX PRO 6000 Blackwell", vramMb: 97887 }],
    estCapacity: 95,
    tdpWatts: 600,
    baseUtilization: 55 + i * 10,
    models: [
      { specifier: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", driver: "vllm" as const, estCapacity: 48 },
    ],
    online: true,
  })),
  {
    host: `${DEMO_HOST_PREFIX}h100-01`,
    machineName: "H100 Inference Server",
    gpus: [{ vendor: "nvidia", name: "NVIDIA H100 80GB HBM3", vramMb: 81559 }],
    estCapacity: 79,
    tdpWatts: 500,
    baseUtilization: 28,
    models: [
      { specifier: "meta-llama/Llama-3.3-70B-Instruct", model: "meta-llama/Llama-3.3-70B-Instruct", driver: "vllm" as const, estCapacity: 70 },
    ],
    online: true,
  },
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

/** Smooth day curve: calm night, busy afternoon, plus per-machine jitter. */
function utilizationAt(machine: DemoMachine, date: Date): number {
  const hourOfDay = date.getHours() + date.getMinutes() / 60;
  const dayCurve = Math.sin(((hourOfDay - 6) / 24) * 2 * Math.PI);
  const jitter = (Math.random() - 0.5) * 14;
  return Math.min(98, Math.max(2, machine.baseUtilization + dayCurve * 22 + jitter));
}

async function main() {
  loadRootEnv();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set and no root .env found");
  }
  const db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();

  const [org] = await db.select().from(organizationT).orderBy(asc(organizationT.createdAt)).limit(1);
  if (!org) {
    throw new Error("No organization found. Log into the dashboard and complete onboarding first.");
  }

  // Replace any previous demo fleet (cascades installations + metrics; usage events first, they only null out).
  const oldNodes = await db.select({ id: aiNodeT.id }).from(aiNodeT).where(like(aiNodeT.host, `${DEMO_HOST_PREFIX}%`));
  if (oldNodes.length > 0) {
    await db.delete(usageEventT).where(inArray(usageEventT.nodeId, oldNodes.map((n) => n.id)));
    await db.delete(aiNodeT).where(inArray(aiNodeT.id, oldNodes.map((n) => n.id)));
  }

  const now = Date.now();

  for (const machine of MACHINES) {
    const lastSeenAt = machine.online ? new Date(now) : new Date(now - 2 * 60 * 60 * 1000);
    const [node] = await db.insert(aiNodeT).values({
      host: machine.host,
      port: 4044,
      estCapacity: machine.estCapacity,
      available: machine.online,
      gpuCount: machine.gpus.length,
      gpus: machine.gpus,
      driverVersions: machine.models.some((m) => m.driver === "vllm") ? { vllm: "0.19.1" } : { ollama: "0.6.3" },
      machineName: machine.machineName,
      lastSeenAt,
      totalEnergyWh: Math.round(machine.tdpWatts * 0.5 * 24 * 30), // ~30 days at half load
    }).returning();

    for (const model of machine.models) {
      const [installation] = await db.insert(modelInstallationT).values({
        nodeId: node.id,
        specifier: model.specifier,
        model: model.model,
        estCapacity: model.estCapacity,
        port: 0,
        driver: model.driver,
      }).returning();
      await db.insert(modelInstallationStateT).values({
        id: installation.id,
        lifecycleState: "ready",
      });
    }

    // 24h of 5-minute metric buckets (offline machine stops 2h ago).
    const metricEnd = machine.online ? now : now - 2 * 60 * 60 * 1000;
    const metrics = [];
    for (let t = now - HOURS * 60 * 60 * 1000; t < metricEnd; t += BUCKET_MS) {
      const bucketStart = new Date(t);
      const utilization = utilizationAt(machine, bucketStart);
      const watts = machine.tdpWatts * (0.1 + 0.9 * (utilization / 100)) * machine.gpus.length;
      metrics.push({
        nodeId: node.id,
        bucketStart,
        gpuUtilizationAvg: utilization,
        gpuUtilizationMax: Math.min(100, utilization + 15),
        memoryUsedMb: Math.round((machine.gpus[0]!.vramMb || 64_000) * (0.5 + utilization / 400)),
        powerWattsAvg: watts,
        energyWh: (watts * BUCKET_MS) / 3_600_000,
      });
    }
    if (metrics.length > 0) await db.insert(nodeMetricT).values(metrics);

    // Usage events roughly tracking the utilization curve, ~1% failures.
    const events = [];
    for (let t = now - HOURS * 60 * 60 * 1000; t < metricEnd; t += 10 * 60 * 1000) {
      const createdAt = new Date(t);
      const callsThisSlot = Math.max(1, Math.round(utilizationAt(machine, createdAt) / 12));
      for (let c = 0; c < callsThisSlot; c++) {
        const failed = Math.random() < 0.01;
        events.push({
          organizationId: org.id,
          model: machine.models[0]!.specifier,
          nodeId: node.id,
          inputTokens: failed ? 0 : 400 + Math.floor(Math.random() * 3200),
          outputTokens: failed ? 0 : 80 + Math.floor(Math.random() * 900),
          duration: 300 + Math.floor(Math.random() * 4000),
          success: !failed,
          createdAt,
        });
      }
    }
    await db.insert(usageEventT).values(events);

    console.log(`Seeded ${machine.host} (${machine.machineName}) — ${metrics.length} metric buckets, ${events.length} usage events${machine.online ? "" : " [offline]"}`);
  }

  console.log(`\nDemo fleet ready: ${MACHINES.length} machines for org "${org.name}". Re-run anytime to refresh.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
