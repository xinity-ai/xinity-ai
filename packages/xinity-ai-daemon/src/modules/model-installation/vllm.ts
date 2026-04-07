import {
  catchError,
  concat,
  defer,
  EMPTY,
  endWith,
  filter,
  from,
  ignoreElements,
  map,
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

const infoClient = createInfoserverClient({ baseUrl: env.INFOSERVER_URL, cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS });

const log = rootLogger.child({ name: "vllm" });

const FATAL_LOG_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // ── GPU / VRAM ───────────────────────────────────────────────────────────
  { pattern: /Free memory on device.*is less than desired GPU memory utilization|Decrease GPU memory utilization/i, label: "GPU memory utilization too high" },
  { pattern: /torch\.cuda\.OutOfMemoryError|torch\.OutOfMemoryError|CUDA out of memory/i, label: "GPU out of memory" },
  { pattern: /Bfloat16 is not supported|bfloat16.*not supported/i, label: "GPU does not support bfloat16" },

  // ── CUDA / driver ────────────────────────────────────────────────────────
  { pattern: /CUDA error: invalid device ordinal/i, label: "Invalid GPU device index" },
  { pattern: /NVIDIA driver on your system is too old|provided PTX was compiled with an unsupported toolchain|cuda capability.*not compatible/i, label: "CUDA/driver version mismatch" },
  { pattern: /RuntimeError:.*CUDA error/i, label: "CUDA runtime error" },

  // ── Container / runtime ──────────────────────────────────────────────────
  { pattern: /could not select device driver|unknown or invalid runtime name: nvidia|Found no NVIDIA driver/i, label: "NVIDIA container runtime missing" },
  { pattern: /ncclSystemError|ncclInternalError|NCCL error/i, label: "NCCL communication error" },
  { pattern: /address already in use|Address already in use/i, label: "Port already in use" },

  // ── Model / config ───────────────────────────────────────────────────────
  { pattern: /Model architectures \[.*\] are not supported/i, label: "Unsupported model architecture" },
  { pattern: /max_model_len.*is too large|the model's max seq_len/i, label: "Configured context length too large" },
  { pattern: /Access to model.*is restricted|gated repo|Cannot access gated repo/i, label: "HuggingFace authentication required" },
  { pattern: /OSError:.*does not appear to have a file named|repository.*not found|does not exist on the Hub/i, label: "Model files missing or not found" },

  // ── Permissions ──────────────────────────────────────────────────────────
  { pattern: /PermissionError:.*triton|triton.*PermissionError/i, label: "Triton cache permission error" },
  { pattern: /PermissionError|Permission denied/i, label: "Permission error" },

  // ── System / process ─────────────────────────────────────────────────────
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

async function updateInstallationState(
  id: string,
  lifecycleState: "downloading" | "installing" | "ready" | "failed",
  opts?: { statusMessage?: string; errorMessage?: string | null; progress?: number | null; failureLogs?: string | null },
): Promise<void> {
  await getDB()
    .insert(modelInstallationStateT)
    .values({
      id,
      lifecycleState,
      progress: opts?.progress ?? null,
      statusMessage: opts?.statusMessage ?? null,
      errorMessage: opts?.errorMessage ?? null,
      failureLogs: opts?.failureLogs ?? null,
    })
    .onConflictDoUpdate({
      set: {
        lifecycleState,
        progress: opts?.progress ?? null,
        statusMessage: opts?.statusMessage ?? null,
        errorMessage: opts?.errorMessage ?? null,
        failureLogs: opts?.failureLogs ?? null,
      },
      target: modelInstallationStateT.id,
    });
}

/**
 * Polls the vLLM health endpoint until it responds, then marks the installation as ready.
 * Checks container liveness each poll; if the container died, fails immediately
 * instead of waiting for the full timeout.
 */
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
        throw new Error(
          `Container for ${installation.model} (${installation.id}) died before becoming healthy`,
        );
      }

      const restartCount = await ops.getRestartCount(installation.id);

      if (restartCount >= env.VLLM_MAX_RESTART_COUNT) {
        const { logs, fatalMatch } = await captureLogsAndMatch(installation.id, ops);
        const reason = fatalMatch ?? "unknown reason";
        throw Object.assign(
          new Error(`Container crash-looping (${restartCount} restarts, ${reason}): ${installation.model}`),
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
        throw new Error(
          `Health check timed out after ${env.VLLM_HEALTH_TIMEOUT_MS}ms for ${installation.model} (${installation.id})`,
        );
      }
    }),
    filter((healthy): healthy is true => healthy),
    take(1),
    switchMap(() =>
      from(
        (async () => {
          // Fire a warmup request to pre-compile Triton kernels so the
          // first real user request doesn't pay the compilation cost.
          // Embedding and rerank models don't serve /v1/chat/completions,
          // so skip warmup for those types.
          if (modelType !== "embedding" && modelType !== "rerank") {
            try {
              await fetch(
                `http://localhost:${installation.port}/v1/chat/completions`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: installation.model,
                    messages: [{ role: "user", content: "warmup" }],
                    max_tokens: 1,
                  }),
                },
              );
              log.info(
                { model: installation.model, installationId: installation.id },
                "vLLM warmup completed",
              );
            } catch {
              // Warmup is best-effort, don't block readiness
            }
          }
          await updateInstallationState(installation.id, "ready", {
            statusMessage: "vLLM server healthy",
          });
        })(),
      ),
    ),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

/**
 * For containers that are running but have a non-"ready" DB state,
 * do a single health + liveness check and correct the state.
 */
function reconcileStaleStates$(
  installations: Array<ModelInstallation>,
  activeSet: Set<string>,
  ops: VllmOps,
): Observable<void> {
  const activeAndDesired = installations.filter((i) => activeSet.has(i.id));
  if (activeAndDesired.length === 0) return EMPTY;

  return defer(() =>
    from(
      getDB()
        .select()
        .from(modelInstallationStateT)
        .where(
          inArray(
            modelInstallationStateT.id,
            activeAndDesired.map((i) => i.id),
          ),
        ),
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
          (installation) =>
            defer(() =>
              from(
                (async () => {
                  const healthy = await ops.checkHealth(installation.port);
                  if (healthy) {
                    await updateInstallationState(installation.id, "ready", {
                      statusMessage: "vLLM server healthy (reconciled)",
                    });
                    log.info(
                      { model: installation.model, installationId: installation.id },
                      "vLLM reconciled to ready",
                    );
                    return;
                  }

                  const alive = await ops.isAlive(installation.id);
                  const currentState = stateMap.get(installation.id);

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
                      log.warn(
                        { model: installation.model, installationId: installation.id, restartCount },
                        "vLLM reconciled to failed (crash-loop detected)",
                      );
                    } else if (currentState?.lifecycleState === "failed") {
                      await updateInstallationState(installation.id, "installing", {
                        statusMessage: "Container still running, awaiting health",
                        errorMessage: null,
                        failureLogs: null,
                      });
                      log.info(
                        { model: installation.model, installationId: installation.id },
                        "vLLM reconciled to installing (container alive, not yet healthy)",
                      );
                    }
                  } else {
                    const logs = await ops.getLogs(installation.id).catch(() => "");
                    await updateInstallationState(installation.id, "failed", {
                      errorMessage: "Container exited unexpectedly",
                      statusMessage: "Container not running",
                      failureLogs: logs || null,
                    });
                    log.warn(
                      { model: installation.model, installationId: installation.id },
                      "vLLM reconciled to failed (container dead)",
                    );
                  }
                })(),
              ),
            ),
          4,
        ),
      );
    }),
    ignoreElements(),
    endWith(void 0 as void),
  );
}

/**
 * Synchronizes vLLM-based installations against running vLLM instances.
 * Compares by installation UUID (not model name) since the same model
 * can run on multiple ports/GPUs.
 *
 * The sync has three phases:
 * 1. Reconcile: fix stale DB state for containers that are already running
 * 2. Remove: stop containers that are running but no longer desired
 * 3. Start + await health: start new containers concurrently and poll
 *    for health concurrently (ports are pre-assigned from the database)
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

      if (toRemove.length)
        log.info({ ids: toRemove }, "vLLM removing stale instances");
      if (candidates.length)
        log.info(
          { instances: candidates.map((i) => `${i.model} (${i.id})`) },
          "vLLM adding instances",
        );

      // Phase 1: Reconcile stale DB state for running containers
      const reconcile$ = reconcileStaleStates$(installations, activeSet, ops);

      // Phase 2: Remove stale containers
      const remove$ = from(toRemove).pipe(
        mergeMap(
          (id) =>
            defer(() => from(ops.stop(id))).pipe(
              tap(() => log.info({ id }, "vLLM stopped instance")),
            ),
          1,
        ),
      );

      // Phase 3: Filter out already-failed installations, then start the rest.
      // Failed installations stay failed until the user re-deploys.
      const awaitHealth$ = defer(() =>
        from(
          candidates.length > 0
            ? getDB()
                .select()
                .from(modelInstallationStateT)
                .where(inArray(modelInstallationStateT.id, candidates.map((i) => i.id)))
            : Promise.resolve([] as Array<{ id: string; lifecycleState: string }>),
        ),
      ).pipe(
        switchMap((states) => {
          const failedIds = new Set(
            states.filter((s) => s.lifecycleState === "failed").map((s) => s.id),
          );
          const toAdd = candidates.filter((i) => !failedIds.has(i.id));

          if (failedIds.size > 0) {
            log.info(
              { ids: [...failedIds] },
              "Skipping failed installations (re-deploy to retry)",
            );
          }

          const start$ = from(toAdd).pipe(
            mergeMap(
              (installation) =>
                defer(() =>
                  from(
                    updateInstallationState(installation.id, "installing", {
                      statusMessage: "Starting vLLM service",
                    }),
                  ),
                ).pipe(
                  switchMap(() =>
                    from(
                      Promise.all([
                        infoClient.hasTag(installation.model, "custom_code"),
                        infoClient.hasTag(installation.model, "tools"),
                        infoClient.resolveDriverArgs(installation.model),
                        infoClient.fetchModel(installation.model),
                        getHardwareProfile(),
                      ]).then(([trustRemoteCode, hasToolsTag, extraArgs, modelInfo, profile]) => {
                        let gpuMemoryUtilization: number | undefined;
                        if (profile.gpuCount > 0 && profile.detectedCapacityGb > 0) {
                          gpuMemoryUtilization = Math.min(
                            (installation.estCapacity * 1.1) / profile.detectedCapacityGb,
                            0.95,
                          );
                          log.info(
                            { model: installation.model, gpuMemoryUtilization: gpuMemoryUtilization.toFixed(3), estCapacityGb: installation.estCapacity, totalCapacityGb: profile.detectedCapacityGb },
                            "Calculated GPU memory utilization",
                          );
                        }
                        const modelType = modelInfo?.type;
                        const resolvedExtraArgs = [
                          ...(modelType === "embedding" || modelType === "rerank" ? ["--runner", "pooling"] : []),
                          ...(hasToolsTag ? ["--enable-auto-tool-choice"] : []),
                          ...extraArgs,
                        ];
                        return ops.start(installation.id, {
                          model: installation.model,
                          port: installation.port,
                          kvCacheBytes: `${installation.kvCacheCapacity}G`,
                          trustRemoteCode,
                          gpuMemoryUtilization,
                          extraArgs: resolvedExtraArgs,
                        }).then(() => modelType);
                      }),
                    ),
                  ),
                  map((modelType) => ({ installation, modelType })),
                ),
            ),
          );

          return start$.pipe(
            mergeMap(({ installation, modelType }) =>
              pollUntilHealthy$(installation, ops, modelType).pipe(
                catchError((err) => {
                  log.error(
                    { err, model: installation.model, installationId: installation.id },
                    "vLLM failed to start",
                  );
                  const preCapturedLogs: string | undefined = (err as { preCapturedLogs?: string })?.preCapturedLogs;
                  return from(
                    (async () => {
                      const logs = preCapturedLogs || await ops.getLogs(installation.id).catch(() => "");
                      await updateInstallationState(installation.id, "failed", {
                        errorMessage: String(err?.message ?? err),
                        statusMessage: "Failed to start",
                        failureLogs: logs || null,
                      });
                      await ops.stop(installation.id).catch(() => {});
                    })().catch(() => {}),
                  ).pipe(ignoreElements());
                }),
              ),
            ),
          );
        }),
      );

      // Execute: reconcile → remove → start + await health
      const work: Observable<unknown>[] = [];
      work.push(reconcile$);
      if (toRemove.length > 0) work.push(remove$.pipe(ignoreElements()));
      if (candidates.length > 0) work.push(awaitHealth$);

      if (work.length === 1 && toRemove.length === 0 && candidates.length === 0) {
        // Only reconciliation, still run it
        return reconcile$;
      }
      return concat(...work).pipe(ignoreElements(), endWith(void 0 as void));
    }),
  );
}
