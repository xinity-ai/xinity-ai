/**
 * Demo compute simulator for local UI development. Creates a set of demo
 * machines, deployments, and model installations so the compute page shows
 * realistic data. Seeds an hour of backfill so charts are not empty, then
 * keeps online machines active with live events for the specified duration.
 *
 * Node states exercised:
 *   - Most nodes online and active
 *   - One node permanently offline throughout
 *   - One node starts offline and toggles every 3 minutes
 *
 * Cleans up all created rows on exit so no stale state is left behind.
 *
 * Usage: bun run simulate:compute [minutes]   (default 30)
 */
import { join } from "path";
import { readFileSync } from "fs";
import {
  aiNodeT,
  modelDeploymentT,
  modelInstallationT,
  modelInstallationStateT,
  organizationT,
  usageEventT,
  preconfigureDB,
  asc,
  eq,
  inArray,
  like,
} from "common-db";

const SIM_DEPLOYMENT_PREFIX = "demo:";
const TICK_MS = 10_000;
const TOGGLE_INTERVAL_MS = 3 * 60 * 1000;
const BACKFILL_HOURS = 1;
const BACKFILL_BUCKET_MS = 10 * 60 * 1000;

type ModelSpec = {
  /** Public canonical identifier shown in the UI (e.g. "qwen3-8b"). */
  publicSpecifier: string;
  /** Provider-specific model string used by the driver — deprecated column, not shown in UI. */
  model: string;
  driver: "ollama" | "vllm";
  estCapacity: number;
};

type DemoMachine = {
  host: string;
  machineName: string;
  gpus: { vendor: string; name: string; vramMb: number }[];
  estCapacity: number;
  baseUtilization: number;
  models: ModelSpec[];
  available: boolean;
  togglesOnOff?: true;
};

const ASCENT_GPUS = [{ vendor: "nvidia", name: "NVIDIA GB10", vramMb: 0 }];
const ASCENT_MODELS: ModelSpec[] = [
  { publicSpecifier: "qwen3-8b", model: "qwen3:8b", driver: "ollama", estCapacity: 8 },
  { publicSpecifier: "nomic-embed", model: "nomic-embed-text", driver: "ollama", estCapacity: 1 },
];

const RTX_GPUS = [{ vendor: "nvidia", name: "NVIDIA RTX PRO 6000 Blackwell", vramMb: 97887 }];
const RTX_MODELS: ModelSpec[] = [
  { publicSpecifier: "mistral-small-3.2-24b", model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", driver: "vllm", estCapacity: 48 },
];

// 192.0.2.0/24 is IANA TEST-NET-1 (RFC 5737) — reserved for documentation,
// never present in a real deployment, safe to use as demo IPs.
const MACHINES: DemoMachine[] = [
  { host: "192.0.2.1", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 43, models: ASCENT_MODELS, available: true },
  { host: "192.0.2.2", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 51, models: ASCENT_MODELS, available: true },
  { host: "192.0.2.3", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 59, models: ASCENT_MODELS, available: false },
  { host: "192.0.2.11", machineName: "RTX PRO 6000 Workstation", gpus: RTX_GPUS, estCapacity: 95, baseUtilization: 65, models: RTX_MODELS, available: true },
  { host: "192.0.2.12", machineName: "RTX PRO 6000 Workstation", gpus: RTX_GPUS, estCapacity: 95, baseUtilization: 75, models: RTX_MODELS, available: false, togglesOnOff: true },
  { host: "192.0.2.21", machineName: "H100 Inference Server", gpus: [{ vendor: "nvidia", name: "NVIDIA H100 80GB HBM3", vramMb: 81559 }], estCapacity: 79, baseUtilization: 28, models: [{ publicSpecifier: "llama-3.3-70b", model: "meta-llama/Llama-3.3-70B-Instruct", driver: "vllm", estCapacity: 70 }], available: true },
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
  if (!org) throw new Error("No organization found. Log into the dashboard and complete onboarding first.");

  // Remove any leftover rows from a previously interrupted run.
  const demoHosts = MACHINES.map((m) => m.host);
  const staleNodes = await db.select({ id: aiNodeT.id }).from(aiNodeT).where(inArray(aiNodeT.host, demoHosts));
  if (staleNodes.length > 0) {
    const ids = staleNodes.map((n) => n.id);
    await db.delete(usageEventT).where(inArray(usageEventT.nodeId, ids));
    await db.delete(aiNodeT).where(inArray(aiNodeT.id, ids)); // cascades to installations + states
  }
  await db.delete(modelDeploymentT).where(like(modelDeploymentT.publicSpecifier, `${SIM_DEPLOYMENT_PREFIX}%`));

  // Create deployments (one per unique model specifier across all machines).
  const uniqueModels = new Map<string, ModelSpec>();
  for (const machine of MACHINES) {
    for (const model of machine.models) {
      if (!uniqueModels.has(model.publicSpecifier)) uniqueModels.set(model.publicSpecifier, model);
    }
  }

  const deploymentIds: string[] = [];
  for (const [publicSpecifier, modelSpec] of uniqueModels) {
    const replicaCount = MACHINES.filter((m) => m.models.some((m2) => m2.publicSpecifier === publicSpecifier)).length;
    const [dep] = await db.insert(modelDeploymentT).values({
      organizationId: org.id,
      name: publicSpecifier,
      publicSpecifier: `${SIM_DEPLOYMENT_PREFIX}${publicSpecifier}`,
      specifier: publicSpecifier,
      modelSpecifier: modelSpec.model,
      replicas: replicaCount,
      enabled: true,
      progress: 100,
    }).returning();
    deploymentIds.push(dep!.id);
  }

  // Create nodes and their model installations.
  const nodeIds: string[] = [];
  const liveNodes: { id: string; phase: number; models: ModelSpec[]; machineName: string; togglesOnOff: boolean; initiallyOnline: boolean }[] = [];

  for (const [index, machine] of MACHINES.entries()) {
    const [node] = await db.insert(aiNodeT).values({
      host: machine.host,
      port: 4044,
      estCapacity: machine.estCapacity,
      available: machine.available,
      gpuCount: machine.gpus.length,
      gpus: machine.gpus,
      driverVersions: machine.models.some((m) => m.driver === "vllm") ? { vllm: "0.19.1" } : { ollama: "0.6.3" },
      machineName: machine.machineName,
    }).returning();

    nodeIds.push(node!.id);
    liveNodes.push({ id: node!.id, phase: index, models: machine.models, machineName: machine.machineName, togglesOnOff: machine.togglesOnOff ?? false, initiallyOnline: machine.available });

    for (const model of machine.models) {
      const [installation] = await db.insert(modelInstallationT).values({
        nodeId: node!.id,
        specifier: model.publicSpecifier,
        model: model.model,
        estCapacity: model.estCapacity,
        kvCacheCapacity: 0,
        port: model.driver === "ollama" ? 11434 : 8000,
        driver: model.driver,
      }).returning();
      await db.insert(modelInstallationStateT).values({ id: installation!.id, lifecycleState: "ready" });
    }
  }

  // Backfill one hour of usage events for all machines. Offline nodes have history too —
  // they processed requests before going down.
  const now = Date.now();
  for (const node of liveNodes) {
    const events = [];
    for (let t = now - BACKFILL_HOURS * 3_600_000; t < now; t += BACKFILL_BUCKET_MS) {
      const utilization = utilizationAt(t, node.phase);
      const calls = Math.max(1, Math.round(utilization / 25));
      for (let c = 0; c < calls; c++) {
        const failed = Math.random() < 0.01;
        events.push({
          organizationId: org.id,
          model: node.models[0]!.publicSpecifier,
          nodeId: node.id,
          inputTokens: failed ? 0 : 400 + Math.floor(Math.random() * 3200),
          outputTokens: failed ? 0 : 80 + Math.floor(Math.random() * 900),
          duration: 300 + Math.floor(Math.random() * 4000),
          success: !failed,
          createdAt: new Date(t),
        });
      }
    }
    await db.insert(usageEventT).values(events);
  }

  const onlineNodes = liveNodes.filter((n) => n.initiallyOnline && !n.togglesOnOff);
  const toggleNode = liveNodes.find((n) => n.togglesOnOff);
  let toggleOnline = false;
  let lastToggle = Date.now();

  const offlineLabel = liveNodes.filter((n) => !n.initiallyOnline && !n.togglesOnOff).map((n) => n.machineName).join(", ");
  console.log(`Created ${liveNodes.length} demo machines with ${BACKFILL_HOURS}h backfill.`);
  console.log(`  Offline (static): ${offlineLabel || "none"}`);
  console.log(`  Toggling (3 min): ${toggleNode?.machineName ?? "none"}`);
  console.log(`Simulating for ${minutes} minutes (Ctrl-C to stop and clean up)...`);

  async function cleanup() {
    console.log("\nCleaning up demo nodes...");
    if (nodeIds.length > 0) {
      await db.delete(usageEventT).where(inArray(usageEventT.nodeId, nodeIds));
      await db.delete(aiNodeT).where(inArray(aiNodeT.id, nodeIds)); // cascades to installations + states
    }
    if (deploymentIds.length > 0) {
      await db.delete(modelDeploymentT).where(inArray(modelDeploymentT.id, deploymentIds));
    }
    console.log("Done.");
    process.exit(0);
  }

  process.on("SIGINT", () => { void cleanup(); });
  process.on("SIGTERM", () => { void cleanup(); });

  while (Date.now() < deadline) {
    const tick = Date.now();

    // Toggle the toggling node.
    if (toggleNode && tick - lastToggle >= TOGGLE_INTERVAL_MS) {
      toggleOnline = !toggleOnline;
      await db.update(aiNodeT).set({ available: toggleOnline }).where(eq(aiNodeT.id, toggleNode.id));
      process.stdout.write(`\n  ${toggleNode.machineName} -> ${toggleOnline ? "online" : "offline"}`);
      lastToggle = tick;
    }

    // Insert usage events for currently online nodes.
    const activeNodes = [
      ...onlineNodes,
      ...(toggleNode && toggleOnline ? [toggleNode] : []),
    ];

    for (const node of activeNodes) {
      const utilization = utilizationAt(tick, node.phase);
      const calls = Math.max(1, Math.round(utilization / 25));
      await db.insert(usageEventT).values(
        Array.from({ length: calls }, () => {
          const failed = Math.random() < 0.01;
          return {
            organizationId: org.id,
            model: node.models[0]!.publicSpecifier,
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

  await cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
