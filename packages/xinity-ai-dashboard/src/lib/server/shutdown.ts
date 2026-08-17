import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "shutdown" });

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Conventional 128 + signal number, matching the disposition this replaces. */
const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGINT: 130 } as const;

type ShutdownSignal = keyof typeof SIGNAL_EXIT_CODES;

type ShutdownTask = { name: string; run: () => Promise<void> | void };

let tasks: ShutdownTask[] = [];
let shuttingDown = false;

/**
 * Registers work to run before the process exits. This module owns the signal
 * handlers, because a listener anywhere else would suppress the default
 * termination and leave the process alive after a stop.
 */
export function onShutdown(name: string, run: () => Promise<void> | void): void {
  tasks.push({ name, run });
}

/** Test-only. Drops every registered task. */
export function resetShutdownTasks(): void {
  tasks = [];
  shuttingDown = false;
}

async function runTask(task: ShutdownTask): Promise<void> {
  try {
    await task.run();
  } catch (err) {
    log.error({ err, task: task.name }, "Shutdown task failed");
  }
}

/** Runs every task concurrently. Returns false when the deadline passed first. */
export async function runShutdownTasks(): Promise<boolean> {
  const completed = Promise.all(tasks.map(runTask)).then(() => true);
  const deadline = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS));
  const finishedInTime = await Promise.race([completed, deadline]);
  if (!finishedInTime) {
    log.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS, tasks: tasks.map((t) => t.name) }, "Shutdown tasks did not finish in time");
  }
  return finishedInTime;
}

export function installShutdownHandlers(): void {
  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as ShutdownSignal[]) {
    process.on(signal, () => {
      const exitCode = SIGNAL_EXIT_CODES[signal];
      if (shuttingDown) {
        log.warn({ signal }, "Signal received while already shutting down, exiting immediately");
        process.exit(exitCode);
      }
      shuttingDown = true;
      log.info({ signal, tasks: tasks.map((t) => t.name) }, "Shutting down");
      void runShutdownTasks().finally(() => process.exit(exitCode));
    });
  }
}
