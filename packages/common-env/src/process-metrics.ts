import { createCounter, createGauge, createHistogram, type Labels, type Metric } from "./metrics-format";

const MS_PER_SECOND = 1e3;
const US_PER_SECOND = 1e6;
const SAMPLE_INTERVAL_MS = 100;
const LAG_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const startTimeSeconds = Date.now() / 1000;

const eventLoopLag = createHistogram(
  "process_event_loop_lag_seconds",
  "Event loop delay, sampled continuously.",
  LAG_BUCKETS,
);

let sampler: Timer | undefined;

/** Started on first scrape so linking common-env costs no timer in a process that exports nothing. */
function startEventLoopSampler(): void {
  if (sampler) {
    return;
  }
  let expected = performance.now() + SAMPLE_INTERVAL_MS;
  sampler = setInterval(() => {
    const now = performance.now();
    eventLoopLag.observe({}, Math.max(0, now - expected) / MS_PER_SECOND);
    expected = now + SAMPLE_INTERVAL_MS;
  }, SAMPLE_INTERVAL_MS);
  sampler.unref();
}

export function createBuildInfo(name: string, labels: Labels): Metric {
  const info = createGauge(name, "Build identity of the running service. The value is always 1.");
  info.set({ ...labels, bun_version: process.versions.bun ?? "unknown" }, 1);
  return info;
}

export function processMetrics(): Metric[] {
  startEventLoopSampler();

  const cpu = process.cpuUsage();

  const startTime = createGauge(
    "process_start_time_seconds",
    "Start time of the process since the unix epoch, in seconds.",
  );
  startTime.set({}, startTimeSeconds);

  const cpuSeconds = createCounter(
    "process_cpu_seconds_total",
    "Total user and system CPU time spent, in seconds.",
  );
  cpuSeconds.inc({ mode: "user" }, cpu.user / US_PER_SECOND);
  cpuSeconds.inc({ mode: "system" }, cpu.system / US_PER_SECOND);

  const residentMemory = createGauge(
    "process_resident_memory_bytes",
    "Resident memory size, in bytes.",
  );
  residentMemory.set({}, process.memoryUsage.rss());

  return [startTime, cpuSeconds, residentMemory, eventLoopLag];
}
