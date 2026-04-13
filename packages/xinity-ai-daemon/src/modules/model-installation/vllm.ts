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
  Observable,
  switchMap,
  take,
  tap,
  timer,
} from "rxjs";
import { getDB } from "../../db/connection";
import { inArray, ModelInstallation, modelInstallationStateT } from "common-db";
import { env } from "../../env";
import {
  createDockerVllmOps,
  createSystemdVllmOps,
  type VllmOps,
} from "./vllm-ops";
import { createInfoserverClient } from "xinity-infoserver";
import { rootLogger } from "../../logger";
import { getHardwareProfile } from "../statekeeper";
import { getFreeMemoryMb } from "../hardware-detect";
import { downloadModel } from "./vllm-download";
import { updateInstallationState } from "./state";

const infoClient = createInfoserverClient({ baseUrl: env.INFOSERVER_URL, cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS });

const log = rootLogger.child({ name: "vllm" });

const FATAL_LOG_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /Free memory on device.*is less than desired GPU memory utilization|Decrease GPU memory utilization/i, label: "GPU memory utilization too high" },
  { pattern: /torch\.cuda\.OutOfMemoryError|torch\.OutOfMemoryError|CUDA out of memory/i, label: "GPU out of memory" },
  { pattern: /Bfloat16 is not supported|bfloat16.*not supported/i, label: "GPU does not support bfloat16" },
  { pattern: /CUDA error: invalid device ordinal/i, label: "Invalid GPU device index" },
  { pattern: /NVIDIA driver on your system is too old|provided PTX was compiled with an unsupported toolchain|cuda capability.*not compatible/i, label: "CUDA/driver version mismatch" },
  { pattern: /RuntimeError:.*CUDA error/i, label: "CUDA runtime error" },
  { pattern: /could not select device driver|unknown or invalid runtime name: nvidia|Found no NVIDIA driver/i, label: "NVIDIA container runtime missing" },
  { pattern: /ncclSystemError|ncclInternalError|NCCL error/i, label: "NCCL communication error" },
  { pattern: /address already in use|Address already in use/i, label: "Port already in use" },
  { pattern: /Model architectures \[.*\] are not supported/i, label: "Unsupported model architecture" },
  { pattern: /max_model_len.*is too large|the model's max seq_len/i, label: "Configured context length too large" },
  { pattern: /Access to model.*is restricted|gated repo|Cannot access gated repo|You must have access to it and be authenticated/i, label: "HuggingFace authentication required" },
  { pattern: /OSError:.*does not appear to have a file named|repository.*not found|does not exist on the Hub/i, label: "Model files missing or not found" },
  { pattern: /PermissionError:.*triton|triton.*PermissionError/i, label: "Triton cache permission error" },
  { pattern: /PermissionError|Permission denied/i, label: "Permission error" },
  { pattern: /error while loading shared libraries/i, label: "Missing shared library" },
  { pattern: /Aborted due to the lack of CPU swap space/i, label: "Insufficient CPU swap space" },
  { pattern: /Engine core initialization failed|EngineCore failed to start/i, label: "Engine initialization failed" },
];

function matchFatalPattern(logs: string): string | null {
  for (const { pattern, label } of FATAL_LOG_PATTERNS) {
    if (pattern.test(logs)) return label;
  }
  return null;
}

async function captureLogsAndMatch(id: string, ops: VllmOps): Promise<{ logs: string; fatalMatch: string | null }> {
  const logs = await ops.getLogs(id).catch(() => "");
  return { logs, fatalMatch: matchFatalPattern(logs) };
}

function resolveDefaultOps(): VllmOps {
  return env.VLLM_BACKEND === "docker"
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

function pollUntilHealthy$(
  installation: ModelInstallation,
  ops: VllmOps,
  modelType?: string,
): Observable<void> {
  const deadline = Date.now() + env.VLLM_HEALTH_TIMEOUT_MS;

  return timer(env.VLLM_HEALTH_POLL_INTERVAL_MS, env.VLLM_HEALTH_POLL_INTERVAL_MS).pipe(
    mergeMap(async () => {
      const alive = await ops.isAlive(installation.id);
      if (!alive) {
        throw new Error(`Container for ${installation.model} (${installation.id}) died before becoming healthy`);
      }

      const restartCount = await ops.getRestartCount(installation.id);

      if (restartCount >= env.VLLM_MAX_RESTART_COUNT) {
        const { logs, fatalMatch } = await captureLogsAndMatch(installation.id, ops);
        throw Object.assign(
          new Error(`Container crash-looping (${restartCount} restarts, ${fatalMatch ?? "unknown reason"}): ${installation.model}`),
          { preCapturedLogs: logs },
        );
      }

      if (restartCount > 0) {
        const { logs, fatalMatch } = await captureLogsAndMatch(installation.id, ops);
        if (fatalMatch) {
          throw Object.assign(
            new Error(`Fatal error detected (${fatalMatch}): ${installation.model}`),
            { preCapturedLogs: logs },
          );
        }
      }

      return ops.checkHealth(installation.port);
    }),
    tap((healthy) => {
      if (!healthy && Date.now() > deadline) {
        throw new Error(`Health check timed out after ${env.VLLM_HEALTH_TIMEOUT_MS}ms for ${installation.model} (${installation.id})`);
      }
    }),
    filter((healthy): healthy is true => healthy),
    take(1),
    switchMap(() =>
      from((async () => {
        if (modelType !== "embedding" && modelType !== "rerank") {
          await warmupChatModel(installation.port, installation.model);
        }
        await updateInstallationState(installation.id, "ready", { statusMessage: "vLLM server healthy" });
      })()),
    ),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

/** Downloads weights, starts the container, and returns the model type for health polling. */
async function downloadAndStart(installation: ModelInstallation, ops: VllmOps): Promise<string | undefined> {
  await updateInstallationState(installation.id, "downloading", { statusMessage: "Downloading model", progress: 0 });

  let lastProgressAt = 0;
  await downloadModel(installation.model, async (progress) => {
    const now = Date.now();
    if (now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      await updateInstallationState(installation.id, "downloading", { progress });
    }
  });

  await updateInstallationState(installation.id, "installing", { statusMessage: "Starting vLLM service" });

  const [trustRemoteCode, hasToolsTag, extraArgs, modelInfo, profile] = await Promise.all([
    infoClient.hasTag(installation.model, "custom_code"),
    infoClient.hasTag(installation.model, "tools"),
    infoClient.resolveDriverArgs(installation.model),
    infoClient.fetchModel(installation.model),
    getHardwareProfile(),
  ]);

  const gpuMemoryUtilization = computeGpuUtilization(installation, profile, await getFreeMemoryMb(profile.source));
  const modelType = modelInfo?.type;

  await ops.start(installation.id, {
    model: installation.model,
    port: installation.port,
    kvCacheBytes: `${installation.kvCacheCapacity}g`,
    trustRemoteCode,
    gpuMemoryUtilization,
    extraArgs: [
      ...(modelType === "embedding" || modelType === "rerank" ? ["--runner", "pooling"] : []),
      ...(hasToolsTag ? ["--enable-auto-tool-choice"] : []),
      ...extraArgs,
    ],
  });

  return modelType;
}

function computeGpuUtilization(
  installation: ModelInstallation,
  profile: { gpuCount: number; detectedCapacityGb: number },
  freeMemoryMb: number | null,
): number | undefined {
  if (profile.gpuCount === 0 || profile.detectedCapacityGb === 0) return undefined;

  const totalCapacityGb = profile.detectedCapacityGb;
  const requiredGb = installation.estCapacity * 1.1;

  let utilization: number;
  if (freeMemoryMb != null) {
    const freeGb = freeMemoryMb / 1024;
    const maxClaimGb = Math.max(freeGb - 1.0, requiredGb);
    utilization = Math.min(maxClaimGb / totalCapacityGb, 0.90);
  } else {
    utilization = Math.min(requiredGb / totalCapacityGb, 0.90);
  }

  log.info(
    { model: installation.model, gpuMemoryUtilization: utilization.toFixed(3), estCapacityGb: installation.estCapacity, totalCapacityGb, freeMemoryMb },
    "Calculated GPU memory utilization",
  );
  return utilization;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function reconcileStaleStates$(
  installations: Array<ModelInstallation>,
  activeSet: Set<string>,
  ops: VllmOps,
): Observable<void> {
  const activeAndDesired = installations.filter((i) => activeSet.has(i.id));
  if (activeAndDesired.length === 0) return EMPTY;

  return defer(() =>
    from(
      getDB().select().from(modelInstallationStateT)
        .where(inArray(modelInstallationStateT.id, activeAndDesired.map((i) => i.id))),
    ),
  ).pipe(
    switchMap((states) => {
      const stateMap = new Map(states.map((s) => [s.id, s]));
      const needsReconciliation = activeAndDesired.filter((i) => {
        const state = stateMap.get(i.id);
        return !state || state.lifecycleState !== "ready";
      });

      if (needsReconciliation.length === 0) return EMPTY;

      log.info(
        { instances: needsReconciliation.map((i) => `${i.model} (${i.id})`) },
        "vLLM reconciling stale state for running instances",
      );

      return from(needsReconciliation).pipe(
        mergeMap(
          (installation) => defer(() => from(reconcileOne(installation, stateMap.get(installation.id), ops))),
          4,
        ),
      );
    }),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

async function reconcileOne(
  installation: ModelInstallation,
  currentState: { lifecycleState: string } | undefined,
  ops: VllmOps,
): Promise<void> {
  const healthy = await ops.checkHealth(installation.port);
  if (healthy) {
    await updateInstallationState(installation.id, "ready", { statusMessage: "vLLM server healthy (reconciled)" });
    log.info({ model: installation.model, installationId: installation.id }, "vLLM reconciled to ready");
    return;
  }

  const alive = await ops.isAlive(installation.id);

  if (alive) {
    const restartCount = await ops.getRestartCount(installation.id);
    if (restartCount >= env.VLLM_MAX_RESTART_COUNT) {
      const { logs, fatalMatch } = await captureLogsAndMatch(installation.id, ops);
      await updateInstallationState(installation.id, "failed", {
        errorMessage: `Container crash-looping (${restartCount} restarts${fatalMatch ? `, ${fatalMatch}` : ""})`,
        statusMessage: "Container crash-looping",
        failureLogs: logs || null,
      });
      await ops.stop(installation.id).catch(() => {});
      log.warn({ model: installation.model, installationId: installation.id, restartCount }, "vLLM reconciled to failed (crash-loop)");
    } else if (currentState?.lifecycleState === "failed") {
      await updateInstallationState(installation.id, "installing", {
        statusMessage: "Container still running, awaiting health",
        errorMessage: null,
        failureLogs: null,
      });
      log.info({ model: installation.model, installationId: installation.id }, "vLLM reconciled to installing (alive, not yet healthy)");
    }
  } else {
    const logs = await ops.getLogs(installation.id).catch(() => "");
    await updateInstallationState(installation.id, "failed", {
      errorMessage: "Container exited unexpectedly",
      statusMessage: "Container not running",
      failureLogs: logs || null,
    });
    log.warn({ model: installation.model, installationId: installation.id }, "vLLM reconciled to failed (container dead)");
  }
}

// ---------------------------------------------------------------------------
// Sync entry point
// ---------------------------------------------------------------------------

/**
 * Synchronizes vLLM installations against running instances in three phases:
 * reconcile stale DB state, remove unwanted containers, then download + start new ones.
 */
export function syncVllmInstallations$(
  installations: Array<ModelInstallation>,
  ops: VllmOps = resolveDefaultOps(),
): Observable<void> {
  return defer(() => from(ops.ensureSetup())).pipe(
    switchMap(() => from(ops.listRunning())),
    switchMap((activeIds) => {
      const desiredIds = new Set(installations.map((i) => i.id));
      const activeSet = new Set(activeIds);
      const toRemove = activeIds.filter((id) => !desiredIds.has(id));
      const candidates = installations.filter((i) => !activeSet.has(i.id));

      if (toRemove.length) log.info({ ids: toRemove }, "vLLM removing stale instances");
      if (candidates.length) log.info({ instances: candidates.map((i) => `${i.model} (${i.id})`) }, "vLLM adding instances");

      const reconcile$ = reconcileStaleStates$(installations, activeSet, ops);
      const remove$ = removeStaleContainers$(toRemove, ops);
      const start$ = startNewInstallations$(candidates, ops);

      const work: Observable<unknown>[] = [reconcile$];
      if (toRemove.length > 0) work.push(remove$);
      if (candidates.length > 0) work.push(start$);

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

function startNewInstallations$(candidates: ModelInstallation[], ops: VllmOps): Observable<void> {
  if (candidates.length === 0) return EMPTY;

  return defer(() =>
    from(
      getDB().select().from(modelInstallationStateT)
        .where(inArray(modelInstallationStateT.id, candidates.map((i) => i.id))),
    ),
  ).pipe(
    switchMap((states) => {
      const failedIds = new Set(states.filter((s) => s.lifecycleState === "failed").map((s) => s.id));
      const toAdd = candidates.filter((i) => !failedIds.has(i.id));

      if (failedIds.size > 0) {
        log.info({ ids: [...failedIds] }, "Skipping failed installations (re-deploy to retry)");
      }

      return from(toAdd).pipe(
        mergeMap((installation) => {
          let containerStarted = false;
          return defer(() =>
            from(downloadAndStart(installation, ops).then((modelType) => {
              containerStarted = true;
              return modelType;
            })),
          ).pipe(
            switchMap((modelType) => pollUntilHealthy$(installation, ops, modelType)),
            catchError((err) => handleInstallationError(err, installation, ops, containerStarted)),
          );
        }),
      );
    }),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

function handleInstallationError(
  err: unknown,
  installation: ModelInstallation,
  ops: VllmOps,
  containerStarted: boolean,
): Observable<never> {
  log.error({ err, model: installation.model, installationId: installation.id }, "vLLM failed to start");

  const preCapturedLogs: string | undefined =
    (err as { preCapturedLogs?: string })?.preCapturedLogs ??
    (err as { downloadLogs?: string })?.downloadLogs;

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
