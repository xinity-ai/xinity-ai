import {
  catchError,
  concat,
  defer,
  EMPTY,
  endWith,
  filter,
  from,
  ignoreElements,
  mergeMap,
  type Observable,
  switchMap,
  take,
  tap,
  timer,
} from "rxjs";
import type { SyncInstallation } from "../db-sync";
import { config } from "../../config";
import {
  createDockerVllmOps,
  createSystemdVllmOps,
  SINGLE_NODE,
  type MemoryUse,
  type VllmOps,
} from "./vllm-ops";
import { rootLogger } from "../../logger";
import { getHardwareProfile } from "../statekeeper";
import { cardCapacityGib, type HardwareProfile } from "../hardware-detect";
import { gpuId, maxNumSeqs, tensorParallelLayouts, type GpuInfo } from "common-env";
import { downloadModel } from "./vllm-download";
import { devicesFor, readHostDevices, resolvePinnedCards } from "./gpu-devices";
import type { ModelSizingFields } from "common-env/model-catalog";
import { dropPageCache } from "./page-cache";
import { resolveInstallationEntry } from "./catalog";
import { updateInstallationState, getLocalInstallationStates } from "./state";

const log = rootLogger.child({ name: "vllm" });

const HEALTHY = "vLLM server healthy";

const FATAL_LOG_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /Free memory on device.*is less than desired GPU memory utilization|Decrease GPU memory utilization/i, label: "GPU memory utilization too high" },
  { pattern: /torch\.(cuda\.)?OutOfMemoryError|(CUDA|HIP|XPU) out of memory|UR_RESULT_ERROR_OUT_OF_DEVICE_MEMORY/i, label: "GPU out of memory" },
  { pattern: /Bfloat16 is not supported|bfloat16.*not supported/i, label: "GPU does not support bfloat16" },
  { pattern: /(CUDA|HIP) error: invalid device ordinal/i, label: "Invalid GPU device index" },
  { pattern: /hipErrorNoBinaryForGpu|HIP error: invalid device function/i, label: "vLLM build has no kernels for this GPU" },
  { pattern: /NVIDIA driver on your system is too old|provided PTX was compiled with an unsupported toolchain|cuda capability.*not compatible/i, label: "CUDA/driver version mismatch" },
  { pattern: /RuntimeError:.*(CUDA|HIP) error|(UR|ZE)_RESULT_ERROR_/i, label: "GPU runtime error" },
  { pattern: /could not select device driver|unknown or invalid runtime name: nvidia|Found no NVIDIA driver/i, label: "NVIDIA container runtime missing" },
  { pattern: /No HIP GPUs are available/i, label: "No GPU visible to vLLM" },
  { pattern: /ncclSystemError|ncclInternalError|NCCL error/i, label: "NCCL communication error" },
  { pattern: /address already in use|Address already in use/i, label: "Port already in use" },
  { pattern: /Model architectures \[.*\] are not supported/i, label: "Unsupported model architecture" },
  { pattern: /No available memory for the cache blocks/i, label: "No GPU memory left for the KV cache" },
  { pattern: /the model's max seq[ _]len/i, label: "KV cache too small for one full-context request" },
  { pattern: /max_model_len.*is too large/i, label: "Configured context length too large" },
  { pattern: /Access to model.*is restricted|gated repo|Cannot access gated repo|You must have access to it and be authenticated/i, label: "HuggingFace authentication required" },
  { pattern: /OSError:.*does not appear to have a file named|repository.*not found|does not exist on the Hub/i, label: "Model files missing or not found" },
  { pattern: /PermissionError:.*triton|triton.*PermissionError/i, label: "Triton cache permission error" },
  { pattern: /PermissionError|Permission denied/i, label: "Permission error" },
  { pattern: /error while loading shared libraries/i, label: "Missing shared library" },
  { pattern: /Aborted due to the lack of CPU swap space/i, label: "Insufficient CPU swap space" },
  { pattern: /Engine core initialization failed|EngineCore failed to start/i, label: "Engine initialization failed" },
];

export function matchFatalPattern(logs: string): string | null {
  for (const { pattern, label } of FATAL_LOG_PATTERNS) {
    if (pattern.test(logs)) {
      return label;
    }
  }
  return null;
}

async function captureLogsAndMatch(id: string, ops: VllmOps): Promise<{ logs: string; fatalMatch: string | null }> {
  const logs = await ops.getLogs(id).catch(() => "");
  return { logs, fatalMatch: matchFatalPattern(logs) };
}

function errorWithPreCapturedLogs(message: string, logs: string): Error {
  return Object.assign(new Error(message), { preCapturedLogs: logs });
}

function resolveDefaultOps(): VllmOps {
  return config.vllm.backend === "docker"
    ? createDockerVllmOps()
    : createSystemdVllmOps();
}

// ---------------------------------------------------------------------------
// Per-installation pipelines
// ---------------------------------------------------------------------------

async function warmupChatModel(port: number, model: string): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "warmup" }], max_tokens: 1 }),
    });
    log.info({ model }, "vLLM warmup completed");
  } catch { /* best-effort */ }
}

async function markInstallationReady(installation: SyncInstallation, providerModel: string, modelType?: string): Promise<void> {
  if (modelType !== "embedding" && modelType !== "rerank" && modelType !== "transcription") {
    await warmupChatModel(installation.port, providerModel);
  }
  await updateInstallationState(installation.id, "ready", { statusMessage: HEALTHY });
  releaseAdmission(installation.id);
}

function throttledDownloadProgress(installationId: string, intervalMs: number): (progress: number) => Promise<void> {
  let lastProgressAt = 0;
  return async (progress) => {
    const now = Date.now();
    if (now - lastProgressAt >= intervalMs) {
      lastProgressAt = now;
      await updateInstallationState(installationId, "downloading", { progress });
    }
  };
}

function pollUntilHealthy$(
  installation: SyncInstallation,
  ops: VllmOps,
  providerModel: string,
  modelType?: string,
): Observable<void> {
  const deadline = Date.now() + config.vllm.healthTimeoutMs();

  return timer(config.vllm.healthPollIntervalMs(), config.vllm.healthPollIntervalMs()).pipe(
    mergeMap(async () => {
      const alive = await ops.isAlive(installation.id);
      if (!alive) {
        throw new Error(`Container for ${installation.specifier} (${installation.id}) died before becoming healthy`);
      }

      const restartCount = await ops.getRestartCount(installation.id);

      if (restartCount > 0) {
        const { logs, fatalMatch } = await captureLogsAndMatch(installation.id, ops);
        if (restartCount >= config.vllm.maxRestartCount()) {
          throw errorWithPreCapturedLogs(
            `Container crash-looping (${restartCount} restarts, ${fatalMatch ?? "unknown reason"}): ${installation.specifier}`,
            logs,
          );
        }
        if (fatalMatch) {
          throw errorWithPreCapturedLogs(
            `Fatal error detected (${fatalMatch}): ${installation.specifier}`,
            logs,
          );
        }
      }

      return ops.checkHealth(installation.port);
    }),
    tap((healthy) => {
      if (!healthy && Date.now() > deadline) {
        throw new Error(`Health check timed out after ${config.vllm.healthTimeoutMs()}ms for ${installation.specifier} (${installation.id})`);
      }
    }),
    filter((healthy): healthy is true => healthy),
    take(1),
    switchMap(() => from(markInstallationReady(installation, providerModel, modelType))),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

// vLLM sizes --kv-cache-memory-bytes per card, so an installation split across cards passes each
// card's share, and sizes utilization against one card's weights and cache.
export function perCardSizing(
  installation: Pick<SyncInstallation, "specifier" | "estCapacity" | "kvCacheCapacity">,
  sizing: ModelSizingFields | undefined,
  cards: number,
): { weightGb: number; kvCacheGb: number } {
  // estCapacity is the VRAM occupied, which includes every card's copy of a replicated kv head, so
  // weights come from the catalog. Only a legacy entry lacks sizing, and it is never split.
  const weightGb = sizing?.weightGb ?? installation.estCapacity - installation.kvCacheCapacity;
  if (cards <= 1) {
    return { weightGb, kvCacheGb: installation.kvCacheCapacity };
  }
  const layout = tensorParallelLayouts({ ...sizing, weightGb }, { cards, kvCacheGb: installation.kvCacheCapacity })
    .find((candidate) => candidate.tensorParallelSize === cards);
  if (!layout) {
    throw new Error(`${installation.specifier} cannot run tensor parallel across ${cards} cards`);
  }
  return { weightGb: layout.perCardWeightGb, kvCacheGb: layout.perCardKvCacheGb };
}

async function downloadAndStart(installation: SyncInstallation, ops: VllmOps): Promise<{ modelType: string | undefined; providerModel: string }> {
  const entry = await resolveInstallationEntry(installation.specifier, "vllm");
  if (!entry) {
    throw new Error(`No vllm catalog entry for installation ${installation.id}`);
  }
  const providerModel = entry.engineSpecifier;
  const profile = await getHardwareProfile();
  const pinnedCards = resolvePinnedCards(profile.gpus, installation.gpuIds);
  const devices = devicesFor(pinnedCards, profile.gpus, await readHostDevices());
  const perCard = perCardSizing(installation, entry.sizing, devices.tensorParallelSize);

  await updateInstallationState(installation.id, "downloading", { statusMessage: "Downloading model", progress: 0 });

  await downloadModel(
    providerModel,
    throttledDownloadProgress(installation.id, 5000),
    entry.downloadFilter,
  );

  await updateInstallationState(installation.id, "installing", { statusMessage: "Starting vLLM service" });

  const charge = footprintCharge(installation, entry.sizing, devices.tensorParallelSize);
  const gpuMemoryUtilization = computeGpuUtilization({
    specifier: installation.specifier,
    gpuGb: charge?.gpuGbPerCard ?? fittedGpuGb(perCard.weightGb, perCard.kvCacheGb),
    gpuIds: installation.gpuIds,
  }, profile);
  const modelType = entry.type;

  await dropPageCache();
  if (charge) {
    await admit(installation.id, charge, devices.tensorParallelSize, profile.source === "unified-memory");
  }

  await ops.start(installation.id, {
    model: providerModel,
    port: installation.port,
    kvCacheBytes: `${perCard.kvCacheGb}g`,
    trustRemoteCode: entry.tags.includes("custom_code"),
    gpuMemoryUtilization,
    extraArgs: buildVllmExtraArgs(
      modelType,
      entry.tags.includes("tools"),
      entry.args,
      installation.hostCapacity === null
        ? entry.sizing && maxNumSeqs({ sizing: entry.sizing, engineArgs: entry.args }, profile.gpus, installation.kvCacheCapacity)
        : installation.maxNumSeqs ?? undefined,
    ),
    settings: installation.settings,
    devices,
    group: SINGLE_NODE,
    hostMemoryLimitBytes: charge && hostMemoryLimitBytes(charge.hostGb),
  });

  return { modelType, providerModel };
}

type FootprintCharge = { gpuGbPerCard: number; hostGb: number };

// A row of the deprecated format is charged no host part, which a limit would turn into a kill.
export function footprintCharge(
  installation: Pick<SyncInstallation, "estCapacity" | "hostCapacity">,
  sizing: ModelSizingFields | undefined,
  cards: number,
): FootprintCharge | undefined {
  if (!sizing || installation.hostCapacity === null) {
    return undefined;
  }
  return { gpuGbPerCard: installation.estCapacity / cards, hostGb: installation.hostCapacity };
}

const HOST_LIMIT_MARGIN = 1.1;
const HOST_LIMIT_MIN_BYTES = 2 ** 30;

export function hostMemoryLimitBytes(hostGb: number): number {
  return Math.max(Math.ceil(hostGb * HOST_LIMIT_MARGIN * 1e9), HOST_LIMIT_MIN_BYTES);
}

async function availableMemoryGb(): Promise<number> {
  const meminfo = await Bun.file("/proc/meminfo").text();
  const kib = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1] ?? 0);
  return (kib * 1024) / 1e9;
}

// An installation still loading has not taken its memory yet, so it holds what it was admitted for
// until it is ready.
const admittedGb = new Map<string, number>();

function releaseAdmission(installationId: string): void {
  admittedGb.delete(installationId);
}

// vLLM checks each card against its window itself. Host memory nothing else checks.
async function admit(installationId: string, charge: FootprintCharge, cards: number, unified: boolean): Promise<void> {
  const neededGb = charge.hostGb + (unified ? charge.gpuGbPerCard * cards : 0);
  const freeGb = await availableMemoryGb();
  const availableGb = freeGb - [...admittedGb.values()].reduce((total, gb) => total + gb, 0);
  if (availableGb < neededGb) {
    throw new Error(`Not enough free memory to start: needs ${neededGb.toFixed(1)} GB, ${availableGb.toFixed(1)} GB available`);
  }
  admittedGb.set(installationId, neededGb);
}

export function buildVllmExtraArgs(
  modelType: string | undefined,
  hasToolsTag: boolean,
  args: readonly string[],
  maxNumSeqs?: number,
): string[] {
  const capConcurrency = maxNumSeqs !== undefined && !args.includes("--max-num-seqs");
  return [
    ...(modelType === "embedding" || modelType === "rerank" ? ["--runner", "pooling"] : []),
    ...(hasToolsTag ? ["--enable-auto-tool-choice"] : []),
    ...(capConcurrency ? ["--max-num-seqs", String(maxNumSeqs)] : []),
    ...args,
  ];
}

// CUDA context, activations and CUDA graphs cost a fixed amount plus a share of the weights,
// not a share of weights plus cache. Fitted to measured loads, see the test that asserts it.
const OVERHEAD_BASE_GIB = 3.5;
const OVERHEAD_WEIGHT_FRACTION = 0.15;
const GB_PER_GIB = 1.073741824;

export function fittedGpuGb(weightGb: number, kvCacheGb: number): number {
  return weightGb * (1 + OVERHEAD_WEIGHT_FRACTION) + kvCacheGb + OVERHEAD_BASE_GIB * GB_PER_GIB;
}

/** Hard cap on vLLM's --gpu-memory-utilization so the driver never claims the whole device. */
const MAX_GPU_UTILIZATION = 0.90;

// An unpinned installation runs on the first card.
function pinnedCardIndices(gpus: readonly GpuInfo[], cardIds: readonly string[]): number[] {
  const indices = gpus.flatMap((gpu, index) => {
    const id = gpuId(gpu);
    return id !== undefined && cardIds.includes(id) ? [index] : [];
  });
  return indices.length > 0 ? indices : [0];
}

export function computeGpuUtilization(
  installation: { specifier: string; gpuGb: number; gpuIds?: string[] },
  profile: Pick<HardwareProfile, "gpus" | "gpuCount" | "systemRamMb" | "detectedCapacityGb" | "physicalCapacityGb">,
): number | undefined {
  if (profile.gpuCount === 0 || profile.physicalCapacityGb === 0) {
    return undefined;
  }

  const neededGib = installation.gpuGb / GB_PER_GIB;
  const cardGib = cardCapacityGib(profile, pinnedCardIndices(profile.gpus, installation.gpuIds ?? []));
  const headroomCap = profile.detectedCapacityGb / profile.physicalCapacityGb;
  const utilization = Math.min(
    neededGib / cardGib,
    headroomCap,
    MAX_GPU_UTILIZATION,
  );

  log.info(
    {
      model: installation.specifier,
      gpuMemoryUtilization: utilization.toFixed(3),
      neededGib,
      cardCapacityGib: cardGib,
      detectedCapacityGb: profile.detectedCapacityGb,
    },
    "Calculated GPU memory utilization",
  );
  return utilization;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function reconcileStaleStates$(
  installations: Array<SyncInstallation>,
  activeSet: Set<string>,
  ops: VllmOps,
): Observable<void> {
  const activeAndDesired = installations.filter((i) => activeSet.has(i.id));
  if (activeAndDesired.length === 0) {
    return EMPTY;
  }

  const stateMap = getLocalInstallationStates(activeAndDesired.map((i) => i.id));
  const needsReconciliation = activeAndDesired.filter((i) => {
    const state = stateMap.get(i.id);
    return !state || state.lifecycleState !== "ready";
  });

  if (needsReconciliation.length === 0) {
    return EMPTY;
  }

  log.info(
    { instances: needsReconciliation.map((i) => `${i.specifier} (${i.id})`) },
    "vLLM reconciling stale state for running instances",
  );

  return from(needsReconciliation).pipe(
    mergeMap(
      (installation) => defer(() => from(reconcileOne(installation, stateMap.get(installation.id), ops))),
      4,
    ),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

const OVER_HOST_BUDGET = "over its host memory budget";

const HOST_USE_WARNING_SHARE = 0.9;
const HOST_USE_WARNING_PREFIX = "Using";

export function hostUseMessage(use: MemoryUse | undefined): string | undefined {
  if (!use?.limitBytes || use.usedBytes < HOST_USE_WARNING_SHARE * use.limitBytes) {
    return undefined;
  }
  return `${HOST_USE_WARNING_PREFIX} ${(use.usedBytes / 1e9).toFixed(1)} of its ${(use.limitBytes / 1e9).toFixed(1)} GB host memory budget`;
}

async function reportHostUse(installation: SyncInstallation, statusMessage: string | null, ops: VllmOps): Promise<void> {
  const warning = hostUseMessage(await ops.memoryUse(installation.id));
  const warned = statusMessage?.startsWith(HOST_USE_WARNING_PREFIX) ?? false;
  if (warning && warning !== statusMessage) {
    await updateInstallationState(installation.id, "ready", { statusMessage: warning });
    log.warn({ model: installation.specifier, installationId: installation.id, warning }, "vLLM close to its host memory budget");
  } else if (!warning && warned) {
    await updateInstallationState(installation.id, "ready", { statusMessage: HEALTHY });
  }
}

function reportHostUse$(installations: SyncInstallation[], activeSet: Set<string>, ops: VllmOps): Observable<void> {
  const running = installations.filter((installation) => activeSet.has(installation.id));
  const states = getLocalInstallationStates(running.map((installation) => installation.id));
  const ready = running.filter((installation) => states.get(installation.id)?.lifecycleState === "ready");
  return from(ready).pipe(
    mergeMap((installation) => defer(() => from(reportHostUse(installation, states.get(installation.id)?.statusMessage ?? null, ops))), 4),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

async function reconcileOne(
  installation: SyncInstallation,
  currentState: { lifecycleState: string } | undefined,
  ops: VllmOps,
): Promise<void> {
  const healthy = await ops.checkHealth(installation.port);
  if (healthy) {
    await updateInstallationState(installation.id, "ready", { statusMessage: "vLLM server healthy (reconciled)" });
    log.info({ model: installation.specifier, installationId: installation.id }, "vLLM reconciled to ready");
    return;
  }

  const alive = await ops.isAlive(installation.id);

  if (alive) {
    const restartCount = await ops.getRestartCount(installation.id);
    if (restartCount >= config.vllm.maxRestartCount()) {
      const { logs, fatalMatch } = await captureLogsAndMatch(installation.id, ops);
      const cause = await ops.wasOomKilled(installation.id) ? OVER_HOST_BUDGET : fatalMatch;
      await updateInstallationState(installation.id, "failed", {
        errorMessage: `Container crash-looping (${restartCount} restarts${cause ? `, ${cause}` : ""})`,
        statusMessage: "Container crash-looping",
        failureLogs: logs || null,
      });
      await ops.stop(installation.id).catch(() => {});
      log.warn({ model: installation.specifier, installationId: installation.id, restartCount }, "vLLM reconciled to failed (crash-loop)");
    } else if (currentState?.lifecycleState === "failed") {
      await updateInstallationState(installation.id, "installing", {
        statusMessage: "Container still running, awaiting health",
        errorMessage: null,
        failureLogs: null,
      });
      log.info({ model: installation.specifier, installationId: installation.id }, "vLLM reconciled to installing (alive, not yet healthy)");
    }
  } else {
    const logs = await ops.getLogs(installation.id).catch(() => "");
    const overBudget = await ops.wasOomKilled(installation.id);
    await updateInstallationState(installation.id, "failed", {
      errorMessage: overBudget ? `Stopped, ${OVER_HOST_BUDGET}` : "Container exited unexpectedly",
      statusMessage: "Container not running",
      failureLogs: logs || null,
    });
    log.warn({ model: installation.specifier, installationId: installation.id }, "vLLM reconciled to failed (container dead)");
  }
}

// ---------------------------------------------------------------------------
// Sync entry point
// ---------------------------------------------------------------------------

export function syncVllmInstallations$(
  installations: Array<SyncInstallation>,
  ops: VllmOps = resolveDefaultOps(),
): Observable<void> {
  return defer(() => from(ops.ensureSetup())).pipe(
    switchMap(() => from(ops.listRunning())),
    switchMap((activeIds) => {
      const desiredIds = new Set(installations.map((i) => i.id));
      const activeSet = new Set(activeIds);
      const toRemove = activeIds.filter((id) => !desiredIds.has(id));
      const candidates = installations.filter((i) => !activeSet.has(i.id));

      if (toRemove.length) {
        log.info({ ids: toRemove }, "vLLM removing stale instances");
      }
      if (candidates.length) {
        log.info({ instances: candidates.map((i) => `${i.specifier} (${i.id})`) }, "vLLM adding instances");
      }

      const reconcile$ = reconcileStaleStates$(installations, activeSet, ops);
      const hostUse$ = reportHostUse$(installations, activeSet, ops);
      const remove$ = removeStaleContainers$(toRemove, ops);
      const start$ = startNewInstallations$(candidates, ops);

      const work: Observable<unknown>[] = [reconcile$, hostUse$];
      if (toRemove.length > 0) {
        work.push(remove$);
      }
      if (candidates.length > 0) {
        work.push(start$);
      }

      return concat(...work).pipe(ignoreElements(), endWith(void 0 as void));
    }),
  );
}

function removeStaleContainers$(ids: string[], ops: VllmOps): Observable<void> {
  return from(ids).pipe(
    mergeMap(
      (id) => defer(() => from(ops.stop(id))).pipe(tap(() => log.info({ id }, "vLLM stopped instance"))),
      1,
    ),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

function startNewInstallations$(candidates: SyncInstallation[], ops: VllmOps): Observable<void> {
  if (candidates.length === 0) {
    return EMPTY;
  }

  const stateMap = getLocalInstallationStates(candidates.map((i) => i.id));
  const failedIds = new Set(
    [...stateMap.entries()]
      .filter(([, s]) => s.lifecycleState === "failed")
      .map(([id]) => id),
  );
  const toAdd = candidates.filter((i) => !failedIds.has(i.id));

  if (failedIds.size > 0) {
    log.info({ ids: [...failedIds] }, "Skipping failed installations (re-deploy to retry)");
  }

  return from(toAdd).pipe(
    mergeMap((installation) => {
      let containerStarted = false;
      return defer(() =>
        from(downloadAndStart(installation, ops).then((res) => {
          containerStarted = true;
          return res;
        })),
      ).pipe(
        switchMap(({ modelType, providerModel }) => pollUntilHealthy$(installation, ops, providerModel, modelType)),
        catchError((err) => handleInstallationError(err, installation, ops, containerStarted)),
      );
    }),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

function handleInstallationError(
  err: unknown,
  installation: SyncInstallation,
  ops: VllmOps,
  containerStarted: boolean,
): Observable<never> {
  log.error({ err, model: installation.specifier, installationId: installation.id }, "vLLM failed to start");
  releaseAdmission(installation.id);

  const preCapturedLogs = (err as { preCapturedLogs?: string })?.preCapturedLogs;

  return from(
    (async () => {
      const logs = preCapturedLogs || (containerStarted ? await ops.getLogs(installation.id).catch(() => "") : "");
      const fatalMatch = logs ? matchFatalPattern(logs) : null;
      await updateInstallationState(installation.id, "failed", {
        errorMessage: fatalMatch ?? String((err as Error)?.message ?? err),
        statusMessage: "Failed to start",
        failureLogs: logs || null,
      });
      if (containerStarted) {
        await ops.stop(installation.id).catch(() => {});
      }
    })().catch(() => {}),
  ).pipe(ignoreElements());
}
