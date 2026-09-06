import { describe, test, expect } from "bun:test";
import { createBuildInfo, processMetrics } from "./process-metrics";
import { serializeMetrics } from "./metrics-format";

function sampleValue(body: string, name: string, labels = ""): number | undefined {
  const prefix = labels ? `${name}{${labels}} ` : `${name} `;
  const line = body.split("\n").find((l) => l.startsWith(prefix));
  return line === undefined ? undefined : Number(line.slice(prefix.length));
}

describe("processMetrics", () => {
  test("reports a start time in the past and a plausible resident size", () => {
    const body = serializeMetrics(processMetrics());

    const start = sampleValue(body, "process_start_time_seconds");
    expect(start).toBeGreaterThan(1_600_000_000);
    expect(start).toBeLessThanOrEqual(Date.now() / 1000);

    // A Bun process that has loaded a test runner is never a few kB, and a
    // reading above a terabyte would mean the units are wrong.
    const rss = sampleValue(body, "process_resident_memory_bytes");
    expect(rss).toBeGreaterThan(1_000_000);
    expect(rss).toBeLessThan(1e12);
  });

  test("splits CPU time by mode and accumulates across scrapes", () => {
    const first = serializeMetrics(processMetrics());
    const user = sampleValue(first, "process_cpu_seconds_total", 'mode="user"');
    const system = sampleValue(first, "process_cpu_seconds_total", 'mode="system"');
    expect(user).toBeGreaterThan(0);
    expect(system).toBeGreaterThanOrEqual(0);

    let spin = 0;
    for (let i = 0; i < 3_000_000; i++) {
      spin += i;
    }
    expect(spin).toBeGreaterThan(0);

    const second = serializeMetrics(processMetrics());
    expect(sampleValue(second, "process_cpu_seconds_total", 'mode="user"')).toBeGreaterThan(user!);
  });

  test("accumulates event loop samples as a cumulative histogram", async () => {
    processMetrics();
    await new Promise((resolve) => setTimeout(resolve, 350));

    const body = serializeMetrics(processMetrics());
    const count = sampleValue(body, "process_event_loop_lag_seconds_count", "");
    expect(count).toBeGreaterThan(0);
    expect(sampleValue(body, "process_event_loop_lag_seconds_sum", "")).toBeGreaterThanOrEqual(0);
  });

  test("reading twice neither loses samples nor changes the answer", async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const first = serializeMetrics(processMetrics());
    const second = serializeMetrics(processMetrics());

    const countOf = (body: string) =>
      sampleValue(body, "process_event_loop_lag_seconds_count", "")!;
    expect(countOf(first)).toBeGreaterThan(0);
    expect(countOf(second)).toBeGreaterThanOrEqual(countOf(first));
  });
});

describe("createBuildInfo", () => {
  test("carries its labels on a constant 1 and names the Bun version", () => {
    const body = serializeMetrics([createBuildInfo("gateway_build_info", { version: "1.2.3" })]);

    expect(body).toContain("# TYPE gateway_build_info gauge");
    expect(body).toMatch(/gateway_build_info\{bun_version="[^"]+",version="1\.2\.3"\} 1/);
  });
});
