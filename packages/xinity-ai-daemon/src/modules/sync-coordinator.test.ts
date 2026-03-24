import { describe, test, expect, mock } from "bun:test";

// Mock env to avoid parseEnv side-effect (requires DB_CONNECTION_URL etc. in CI)
mock.module("../env", () => ({ env: {
  PORT: 4010,
  HOST: "0.0.0.0",
  XINITY_OLLAMA_ENDPOINT: "http://localhost:11434",
  DB_CONNECTION_URL: "postgres://localhost/test",
  STATE_DIR: "/tmp/test-state",
  CIDR_PREFIX: "",
  SYNC_INTERVAL_MS: 60_000,
  INFOSERVER_URL: "http://localhost:19090",
  INFOSERVER_CACHE_TTL_MS: 30_000,
  VLLM_BACKEND: "systemd",
  VLLM_ENV_DIR: "/etc/vllm",
  VLLM_TEMPLATE_UNIT_PATH: "/etc/systemd/system/vllm-driver@.service",
  VLLM_PATH: undefined,
  VLLM_DOCKER_IMAGE: undefined,
  VLLM_HF_CACHE_DIR: "/var/lib/vllm/hf-cache",
  VLLM_TRITON_CACHE_DIR: "/var/lib/vllm/triton-cache",
  VLLM_HEALTH_TIMEOUT_MS: 3_600_000,
  VLLM_HEALTH_POLL_INTERVAL_MS: 5_000,
  VLLM_MAX_RESTART_COUNT: 3,
  LOG_LEVEL: "silent",
  LOG_DIR: undefined,
}}));

const { createWorkflowCoordinator } = await import("./sync-coordinator");
type WorkflowTrigger = import("./sync-coordinator").WorkflowTrigger;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a deferred promise that can be resolved externally. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Small async delay for letting RxJS streams process. */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// createWorkflowCoordinator
// ---------------------------------------------------------------------------

describe("createWorkflowCoordinator", () => {
  test("runs workflow on initial interval trigger", async () => {
    let runCount = 0;
    const d = deferred();

    const coordinator = createWorkflowCoordinator({
      periodMs: 60_000, // long period, only the initial timer(0, ...) fires
      run: async () => {
        runCount++;
        d.resolve();
      },
    });

    const sub = coordinator.start();
    await d.promise;
    expect(runCount).toBe(1);
    sub.unsubscribe();
  });

  test("runs workflow on signal trigger", async () => {
    const triggers: WorkflowTrigger[] = [];
    let runCount = 0;
    const firstDone = deferred();
    const secondDone = deferred();

    const coordinator = createWorkflowCoordinator({
      periodMs: 60_000,
      run: async (trigger) => {
        triggers.push(trigger);
        runCount++;
        if (runCount === 1) firstDone.resolve();
        if (runCount === 2) secondDone.resolve();
      },
    });

    const sub = coordinator.start();
    // Wait for initial interval trigger
    await firstDone.promise;

    // Now send a signal
    coordinator.signal("test");
    await secondDone.promise;

    expect(runCount).toBe(2);
    expect(triggers[1]!.kind).toBe("signal");
    sub.unsubscribe();
  });

  test("queues at most one run when workflow is in progress", async () => {
    const drops: WorkflowTrigger[] = [];
    let runCount = 0;
    const gate = deferred();
    const allDone = deferred();

    const coordinator = createWorkflowCoordinator({
      periodMs: 60_000,
      run: async () => {
        runCount++;
        if (runCount === 1) {
          // Block the first run so signals queue up
          await gate.promise;
        }
        if (runCount === 2) {
          // Second run completes immediately, it's the queued one
          allDone.resolve();
        }
      },
      onDrop: (trigger) => drops.push(trigger),
    });

    const sub = coordinator.start();
    await tick(); // let the initial interval trigger start

    // Send 3 signals while the first run is in progress
    coordinator.signal("s1");
    coordinator.signal("s2");
    coordinator.signal("s3");
    await tick();

    // Unblock the first run
    gate.resolve();
    await allDone.promise;

    // Exactly 2 runs: initial + 1 queued. Extra signals are dropped.
    expect(runCount).toBe(2);
    // At least one drop should have occurred (s2 or s3)
    expect(drops.length).toBeGreaterThanOrEqual(1);

    sub.unsubscribe();
  });

  test("calls onError when workflow throws, keeps running", async () => {
    const errors: unknown[] = [];
    let errorThrown = false;
    const postErrorRun = deferred();

    const coordinator = createWorkflowCoordinator({
      periodMs: 60_000,
      run: async () => {
        if (!errorThrown) {
          errorThrown = true;
          throw new Error("workflow failed");
        }
        postErrorRun.resolve();
      },
      onError: (err) => errors.push(err),
    });

    const sub = coordinator.start();
    await tick(50); // let the error run complete

    // Signal to verify the coordinator is still alive after an error
    coordinator.signal("after-error");
    await postErrorRun.promise;

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("workflow failed");
    sub.unsubscribe();
  });

  test("executes runs sequentially (no overlap)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runCount = 0;
    const done = deferred();

    const coordinator = createWorkflowCoordinator({
      periodMs: 60_000,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Simulate work
        await tick(30);
        concurrent--;
        runCount++;
        if (runCount >= 2) done.resolve();
      },
    });

    const sub = coordinator.start();
    await tick(10); // first run starts
    coordinator.signal("overlap-attempt");
    await done.promise;

    expect(maxConcurrent).toBe(1);
    expect(runCount).toBeGreaterThanOrEqual(2);
    sub.unsubscribe();
  });

  test("unsubscribe stops the coordinator", async () => {
    let runCount = 0;

    const coordinator = createWorkflowCoordinator({
      periodMs: 60_000,
      run: async () => {
        runCount++;
      },
    });

    const sub = coordinator.start();
    await tick(50);
    const countAfterStart = runCount;
    sub.unsubscribe();

    // Send signals after unsubscribe, should not trigger runs
    coordinator.signal("after-unsub");
    await tick(50);

    expect(runCount).toBe(countAfterStart);
  });
});
