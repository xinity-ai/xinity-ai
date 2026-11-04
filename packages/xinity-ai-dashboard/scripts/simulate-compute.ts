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
 *   - One node removed from the cluster while its installations survive
 *   - Two coupled nodes serving one replica of a model too large for either
 *
 * Deployments are managed, except one legacy and one canary rolling out over
 * a day, so every deployment type shows in the model hub.
 *
 * Cleans up all created rows on exit so no stale state is left behind.
 *
 * Usage: bun run simulate:compute [small|large] [minutes]   (default: small 30)
 *
 *   small  9 machines, 4 models (quick iteration)
 *   large  57 machines, 8 models with 4-25 replicas each (stress-test UI)
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  aiNodeT,
  deploymentT,
  deploymentLegacyT,
  deploymentManagedT,
  deploymentCanaryT,
  modelInstallationT,
  modelInstallationStateT,
  organizationT,
  usageEventT,
  preconfigureDB,
  asc,
  sql,
  inArray,
} from "common-db";
import type { GpuInfo, InstallationGroup, InterconnectPort } from "common-env";

// Named the way a team names what it runs: by purpose, with a public name of its own, neither one the model's.
const DEMO_NAMES: Record<string, { name: string; publicSpecifier: string }> = {
  "bge-m3-ollama": { name: "Document search", publicSpecifier: "demo-docs-embed" },
  "gemma-4-26b-a4b-nvfp4-vllm": { name: "Drafting assistant", publicSpecifier: "demo-drafting" },
  "mimo-v2.6-flash-vllm": { name: "Coding agent", publicSpecifier: "demo-coding-agent" },
  "phi-4-14b-vllm": { name: "Reasoning sandbox", publicSpecifier: "demo-reasoning" },
  "phi-4-mini-vllm": { name: "Ticket triage", publicSpecifier: "demo-triage" },
  "qwen3-30b-a3b-instruct-fp8-vllm": { name: "Support assistant", publicSpecifier: "demo-support-assistant" },
  "qwen3.6-35b-a3b-fp8-vllm": { name: "Internal chat", publicSpecifier: "demo-internal-chat" },
  "qwen3.6-35b-a3b-ollama": { name: "Edge assistant", publicSpecifier: "demo-edge-assistant" },
  "qwen3-asr-1.7b-vllm": { name: "Meeting transcripts", publicSpecifier: "demo-transcribe" },
};
// Marks what the simulator created, so cleanup leaves real deployments alone.
const SIM_DEPLOYMENT_PREFIX = "demo-";
const namesOf = (specifier: string) => DEMO_NAMES[specifier] ?? { name: specifier, publicSpecifier: `${SIM_DEPLOYMENT_PREFIX}${specifier}` };
const TICK_MS = 10_000;
const TOGGLE_INTERVAL_MS = 3 * 60 * 1000;
const BACKFILL_HOURS = 1;
const BACKFILL_BUCKET_MS = 10 * 60 * 1000;
// The highest minimum any catalog entry names, so no model is ruled out for an old engine. Raise them as the catalog does.
const VLLM_VERSION = "0.33.0";
const OLLAMA_VERSION = "0.33.1";

type ModelSpec = {
  publicSpecifier: string;
  driver: "ollama" | "vllm";
  estCapacity: number;
  lifecycleState?: "ready" | "downloading" | "installing" | "failed";
  group?: InstallationGroup;
};

type DemoMachine = {
  host: string;
  machineName: string;
  gpus: GpuInfo[];
  estCapacity: number;
  baseUtilization: number;
  models: ModelSpec[];
  available: boolean;
  togglesOnOff?: true;
  removed?: true;
  interconnect?: InterconnectPort[];
};

const ASCENT_GPUS = [{ vendor: "nvidia", name: "NVIDIA GB10", vramMb: 0 }];
const RTX_GPUS = [{ vendor: "nvidia", name: "NVIDIA RTX PRO 6000 Blackwell", vramMb: 97887 }];
const H100_GPUS = [{ vendor: "nvidia", name: "NVIDIA H100 80GB HBM3", vramMb: 81559 }];

// 192.0.2.0/24 is IANA TEST-NET-1 (RFC 5737), reserved for documentation,
// never present in a real deployment, safe to use as demo IPs.

const ASCENT_MODELS: ModelSpec[] = [
  { publicSpecifier: "qwen3.6-35b-a3b-ollama", driver: "ollama", estCapacity: 8 },
  { publicSpecifier: "bge-m3-ollama", driver: "ollama", estCapacity: 1 },
];

const CANARY_FROM: ModelSpec = { publicSpecifier: "qwen3.6-27b-fp8-vllm", driver: "vllm", estCapacity: 48 };
const CANARY_TO: ModelSpec = { publicSpecifier: "qwen3.6-35b-a3b-fp8-vllm", driver: "vllm", estCapacity: 48 };

// Two GX10s cabled port to port, one subnet per PCIe path, serving tensor parallel across both.
function coupledPair(hosts: [string, string], spec: Omit<ModelSpec, "group">): DemoMachine[] {
  const groupId = crypto.randomUUID();
  const macs = hosts.map((_, index) => [`02:00:00:00:0${index}:01`, `02:00:00:00:0${index}:02`]);
  const subnets = ["198.51.100", "198.51.101"];
  return hosts.map((host, rank): DemoMachine => ({
    host,
    machineName: "Ascent GX10",
    gpus: ASCENT_GPUS,
    estCapacity: 110,
    baseUtilization: 70 + rank * 4,
    available: true,
    interconnect: [{
      networkCard: "ConnectX-7",
      port: "p0",
      paths: subnets.map((subnet, path) => ({
        interface: `enp1s0f0np${path}`,
        mac: macs[rank]![path]!,
        carrier: true,
        mtu: 9000,
        speedMbps: 200000,
        linkLayer: "Ethernet",
        ipv4: [`${subnet}.${rank + 1}/24`],
        roceV2Ipv4: [`${subnet}.${rank + 1}`],
        addressLosses: 0,
      })),
      neighbours: macs[1 - rank]!,
    }],
    models: [{
      ...spec,
      group: {
        id: groupId, rank, size: 2, parallelism: "tensor", rendezvousPort: 29500, generation: 1,
        addresses: subnets.map((subnet) => ({ subnet: `${subnet}.0/24`, address: `${subnet}.${rank + 1}` })),
      },
    }],
  }));
}

const COUPLED_MODEL: Omit<ModelSpec, "group"> = { publicSpecifier: "mimo-v2.6-flash-vllm", driver: "vllm", estCapacity: 98 };

type DemoDeployment =
  | { type: "managed" | "legacy"; specifier: string }
  | { type: "canary"; from: string; to: string; progress: number };

/** Anything installed that no entry names becomes a managed deployment of its own. */
const DEMO_DEPLOYMENTS: DemoDeployment[] = [
  { type: "legacy", specifier: "bge-m3-ollama" },
  { type: "canary", from: CANARY_FROM.publicSpecifier, to: CANARY_TO.publicSpecifier, progress: 30 },
];

const SMALL_MACHINES: DemoMachine[] = [
  { host: "192.0.2.1", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 43, models: ASCENT_MODELS, available: true },
  { host: "192.0.2.2", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 51, models: ASCENT_MODELS, available: true },
  { host: "192.0.2.3", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 59, models: ASCENT_MODELS, available: false },
  { host: "192.0.2.4", machineName: "Ascent GX10", gpus: ASCENT_GPUS, estCapacity: 110, baseUtilization: 47, models: ASCENT_MODELS, available: true, removed: true },
  { host: "192.0.2.11", machineName: "RTX PRO 6000 Workstation", gpus: RTX_GPUS, estCapacity: 95, baseUtilization: 65, models: [CANARY_FROM], available: true },
  { host: "192.0.2.12", machineName: "RTX PRO 6000 Workstation", gpus: RTX_GPUS, estCapacity: 95, baseUtilization: 75, models: [CANARY_TO], available: false, togglesOnOff: true },
  { host: "192.0.2.21", machineName: "H100 Inference Server", gpus: H100_GPUS, estCapacity: 79, baseUtilization: 28, models: [{ publicSpecifier: "qwen3-30b-a3b-instruct-fp8-vllm", driver: "vllm", estCapacity: 70 }], available: true },
  ...coupledPair(["192.0.2.31", "192.0.2.32"], COUPLED_MODEL),
];

function generateLargeMachines(): DemoMachine[] {
  const machines: DemoMachine[] = [];
  let ip = 1;

  // 25 Ascent GX10 edge devices
  for (let i = 0; i < 25; i++) {
    const offline = i === 3;
    machines.push({
      host: `192.0.2.${ip++}`,
      machineName: "Ascent GX10",
      gpus: ASCENT_GPUS,
      estCapacity: 110,
      baseUtilization: 35 + (i * 3) % 30,
      models: [
        {
          publicSpecifier: "qwen3.6-35b-a3b-ollama",
          driver: "ollama",
          estCapacity: 8,
          lifecycleState: offline ? "failed" : (i === 7 || i === 15) ? "downloading" : "ready",
        },
        {
          publicSpecifier: "bge-m3-ollama",
          driver: "ollama",
          estCapacity: 1,
          lifecycleState: offline ? "failed" : "ready",
        },
      ],
      available: !offline,
      ...(i === 20 ? { removed: true as const } : {}),
    });
  }

  // 12 RTX PRO 6000 Workstations
  for (let i = 0; i < 12; i++) {
    machines.push({
      host: `192.0.2.${ip++}`,
      machineName: "RTX PRO 6000 Workstation",
      gpus: RTX_GPUS,
      estCapacity: 95,
      baseUtilization: 50 + (i * 5) % 25,
      models: [
        i % 3 === 0 ? CANARY_FROM : CANARY_TO,
        {
          publicSpecifier: "gemma-4-26b-a4b-nvfp4-vllm",
          driver: "vllm",
          estCapacity: 24,
          lifecycleState: i === 4 ? "installing" : "ready",
        },
      ],
      available: true,
      ...(i === 0 ? { togglesOnOff: true as const } : {}),
    });
  }

  // 8 H100 inference servers
  for (let i = 0; i < 8; i++) {
    machines.push({
      host: `192.0.2.${ip++}`,
      machineName: "H100 Inference Server",
      gpus: H100_GPUS,
      estCapacity: 79,
      baseUtilization: 25 + (i * 7) % 30,
      models: [
        { publicSpecifier: "qwen3-30b-a3b-instruct-fp8-vllm", driver: "vllm", estCapacity: 70 },
        {
          publicSpecifier: "phi-4-mini-vllm",
          driver: "vllm",
          estCapacity: 12,
          lifecycleState: i === 2 ? "failed" : "ready",
        },
      ],
      available: i !== 5,
    });
  }

  // 6 A100 cluster nodes
  for (let i = 0; i < 6; i++) {
    machines.push({
      host: `192.0.2.${ip++}`,
      machineName: "A100 Cluster Node",
      gpus: [{ vendor: "nvidia", name: "NVIDIA A100 80GB", vramMb: 81920 }],
      estCapacity: 85,
      baseUtilization: 40 + (i * 6) % 25,
      models: [
        { publicSpecifier: "phi-4-14b-vllm", driver: "vllm", estCapacity: 70 },
        { publicSpecifier: "qwen3-30b-a3b-instruct-fp8-vllm", driver: "vllm", estCapacity: 70 },
      ],
      available: true,
    });
  }

  // 4 L40S workstations
  for (let i = 0; i < 4; i++) {
    machines.push({
      host: `192.0.2.${ip++}`,
      machineName: "L40S Workstation",
      gpus: [{ vendor: "nvidia", name: "NVIDIA L40S", vramMb: 46068 }],
      estCapacity: 60,
      baseUtilization: 30 + (i * 8) % 20,
      models: [
        { publicSpecifier: "qwen3-asr-1.7b-vllm", driver: "vllm", estCapacity: 8 },
      ],
      available: true,
    });
  }

  machines.push(...coupledPair([`192.0.2.${ip++}`, `192.0.2.${ip++}`], COUPLED_MODEL));

  return machines;
}

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
  const deleteDemoDeployments = async () => {
    const deleted = await db.delete(deploymentT)
      .where(sql`${deploymentT.publicSpecifier} LIKE ${SIM_DEPLOYMENT_PREFIX + "%"}`)
      .returning({ legacyId: deploymentT.legacyId, managedId: deploymentT.managedId, canaryId: deploymentT.canaryId });
    const canaryIds = deleted.flatMap(({ canaryId }) => (canaryId ? [canaryId] : []));
    const members = canaryIds.length > 0
      ? await db.delete(deploymentCanaryT).where(inArray(deploymentCanaryT.id, canaryIds))
        .returning({ fromId: deploymentCanaryT.fromId, toId: deploymentCanaryT.toId })
      : [];
    const legacyIds = deleted.flatMap(({ legacyId }) => (legacyId ? [legacyId] : []));
    const managedIds = [
      ...deleted.flatMap(({ managedId }) => (managedId ? [managedId] : [])),
      ...members.flatMap(({ fromId, toId }) => [fromId, toId]),
    ];
    if (legacyIds.length > 0) {
      await db.delete(deploymentLegacyT).where(inArray(deploymentLegacyT.id, legacyIds));
    }
    if (managedIds.length > 0) {
      await db.delete(deploymentManagedT).where(inArray(deploymentManagedT.id, managedIds));
    }
  };

  const arg1 = process.argv[2];
  const presetName = (arg1 === "small" || arg1 === "large") ? arg1 : undefined;
  const minutesArg = presetName ? process.argv[3] : process.argv[2];
  const preset = presetName ?? "small";
  const minutes = Number(minutesArg) || 30;
  const machines = preset === "large" ? generateLargeMachines() : SMALL_MACHINES;
  const deadline = Date.now() + minutes * 60 * 1000;

  const [org] = await db.select().from(organizationT).orderBy(asc(organizationT.createdAt)).limit(1);
  if (!org) throw new Error("No organization found. Log into the dashboard and complete onboarding first.");

  // Remove any leftover rows from a previously interrupted run.
  const demoHosts = machines.map((m) => m.host);
  const staleNodes = await db.select({ id: aiNodeT.id }).from(aiNodeT).where(inArray(aiNodeT.host, demoHosts));
  if (staleNodes.length > 0) {
    const ids = staleNodes.map((n) => n.id);
    await db.delete(usageEventT).where(inArray(usageEventT.nodeId, ids));
    await db.delete(aiNodeT).where(inArray(aiNodeT.id, ids));
  }
  await deleteDemoDeployments();

  // Create deployments: those DEMO_DEPLOYMENTS names, and a managed one for every other model installed.
  // A coupled group is one replica however many machines it spans.
  const replicasOf = (...specifiers: string[]) =>
    new Set(machines.flatMap((m) => m.models
      .filter((model) => specifiers.includes(model.publicSpecifier))
      .map((model) => model.group?.id ?? m.host))).size;
  const installed = new Set(machines.flatMap((m) => m.models.map((model) => model.publicSpecifier)));
  const named = new Set(DEMO_DEPLOYMENTS.flatMap((d) => d.type === "canary" ? [d.from, d.to] : [d.specifier]));
  const deployments: DemoDeployment[] = [
    ...DEMO_DEPLOYMENTS,
    ...[...installed].filter((specifier) => !named.has(specifier)).map((specifier) => ({ type: "managed" as const, specifier })),
  ];

  type Owner = { legacyId: string } | { managedId: string };
  const ownerBySpecifier = new Map<string, Owner>();
  const insertManaged = async (specifier: string, replicas: number) => {
    const [managed] = await db.insert(deploymentManagedT).values({ specifier, replicas }).returning();
    ownerBySpecifier.set(specifier, { managedId: managed!.id });
    return managed!.id;
  };

  for (const deployment of deployments) {
    const shared = { organizationId: org.id, enabled: true };
    if (deployment.type === "canary") {
      const replicas = replicasOf(deployment.from, deployment.to);
      const now = new Date();
      const [canary] = await db.insert(deploymentCanaryT).values({
        fromId: await insertManaged(deployment.from, replicas),
        toId: await insertManaged(deployment.to, replicas),
        replicas,
        progress: deployment.progress,
        advance: {
          type: "time", version: 1, startProgress: deployment.progress,
          from: now.toISOString(), until: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        },
      }).returning();
      await db.insert(deploymentT).values({
        ...shared, ...namesOf(deployment.to), type: "canary", canaryId: canary!.id,
      });
    } else if (deployment.type === "legacy") {
      const [legacy] = await db.insert(deploymentLegacyT).values({
        specifier: deployment.specifier, replicas: replicasOf(deployment.specifier), progress: 100,
      }).returning();
      ownerBySpecifier.set(deployment.specifier, { legacyId: legacy!.id });
      await db.insert(deploymentT).values({
        ...shared, ...namesOf(deployment.specifier), type: "legacy", legacyId: legacy!.id,
      });
    } else {
      const managedId = await insertManaged(deployment.specifier, replicasOf(deployment.specifier));
      await db.insert(deploymentT).values({
        ...shared, ...namesOf(deployment.specifier), type: "managed", managedId,
      });
    }
  }

  // Create nodes and their model installations.
  const nodeIds: string[] = [];
  const liveNodes: { id: string; phase: number; models: ModelSpec[]; machineName: string; togglesOnOff: boolean; initiallyOnline: boolean; removed: boolean }[] = [];

  for (const [index, machine] of machines.entries()) {
    const [node] = await db.insert(aiNodeT).values({
      host: machine.host,
      port: 4044,
      estCapacity: machine.estCapacity,
      available: machine.available,
      gpuCount: machine.gpus.length,
      gpus: machine.gpus,
      driverVersions: machine.models.some((m) => m.driver === "vllm") ? { vllm: VLLM_VERSION } : { ollama: OLLAMA_VERSION },
      machineName: machine.machineName,
      interconnect: machine.interconnect ?? [],
      deletedAt: machine.removed ? new Date() : null,
    }).returning();

    nodeIds.push(node!.id);
    liveNodes.push({ id: node!.id, phase: index, models: machine.models, machineName: machine.machineName, togglesOnOff: machine.togglesOnOff ?? false, initiallyOnline: machine.available, removed: machine.removed ?? false });

    for (const model of machine.models) {
      const [installation] = await db.insert(modelInstallationT).values({
        nodeId: node!.id,
        ...ownerBySpecifier.get(model.publicSpecifier)!,
        specifier: model.publicSpecifier,
        estCapacity: model.estCapacity,
        kvCacheCapacity: 0,
        port: model.driver === "ollama" ? 11434 : 8000,
        driver: model.driver,
        group: model.group ?? null,
      }).returning();
      await db.insert(modelInstallationStateT).values({
        id: installation!.id,
        lifecycleState: model.lifecycleState ?? "ready",
      });
    }
  }

  // Backfill one hour of usage events for all machines. Offline nodes have
  // history too, they processed requests before going down.
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

  const onlineNodes = liveNodes.filter((n) => n.initiallyOnline && !n.togglesOnOff && !n.removed);
  const toggleNode = liveNodes.find((n) => n.togglesOnOff);
  let toggleOnline = false;
  let lastToggle = Date.now();

  const offlineLabel = liveNodes.filter((n) => !n.initiallyOnline && !n.togglesOnOff && !n.removed).map((n) => n.machineName).join(", ");
  const removedLabel = liveNodes.filter((n) => n.removed).map((n) => n.machineName).join(", ");
  console.log(`[${preset}] Created ${liveNodes.length} demo machines with ${BACKFILL_HOURS}h backfill.`);
  console.log(`  Offline (static): ${offlineLabel || "none"}`);
  console.log(`  Toggling (3 min): ${toggleNode?.machineName ?? "none"}`);
  console.log(`  Removed, installations kept: ${removedLabel || "none"}`);
  console.log(`Simulating for ${minutes} minutes (Ctrl-C to stop and clean up)...`);

  async function cleanup() {
    console.log("\nCleaning up demo nodes...");
    if (nodeIds.length > 0) {
      await db.delete(usageEventT).where(inArray(usageEventT.nodeId, nodeIds));
      await db.delete(aiNodeT).where(inArray(aiNodeT.id, nodeIds));
    }
    await deleteDemoDeployments();
    console.log("Done.");
    process.exit(0);
  }

  process.on("SIGINT", () => { void cleanup(); });
  process.on("SIGTERM", () => { void cleanup(); });

  while (Date.now() < deadline) {
    const tick = Date.now();

    if (toggleNode && tick - lastToggle >= TOGGLE_INTERVAL_MS) {
      toggleOnline = !toggleOnline;
      await db.update(aiNodeT).set({ available: toggleOnline }).where(sql`${aiNodeT.id} = ${toggleNode.id}`);
      process.stdout.write(`\n  ${toggleNode.machineName} -> ${toggleOnline ? "online" : "offline"}`);
      lastToggle = tick;
    }

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
