import { describe, test, expect } from "bun:test";
import { formatTokens, formatEnergy, formatPercent, formatRelativeTime, gpuSummary } from "./format";

describe("formatTokens", () => {
  test("abbreviates magnitudes", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(4_200_000)).toBe("4.2M");
    expect(formatTokens(1_300_000_000)).toBe("1.3B");
  });
});

describe("formatEnergy", () => {
  test("scales Wh to kWh and MWh", () => {
    expect(formatEnergy(420)).toBe("420 Wh");
    expect(formatEnergy(1_234)).toBe("1.2 kWh");
    expect(formatEnergy(2_000_000)).toBe("2 MWh");
  });
});

describe("formatPercent", () => {
  test("rounds and caps cleanly at 100", () => {
    expect(formatPercent(99.97)).toBe("100%");
    expect(formatPercent(99.24)).toBe("99.2%");
    expect(formatPercent(50)).toBe("50%");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  test("buckets into minutes, hours, days", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 10 * 60_000, now)).toBe("10m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
});

describe("gpuSummary", () => {
  test("groups identical GPUs with counts", () => {
    expect(gpuSummary([{ name: "NVIDIA H100" }])).toBe("NVIDIA H100");
    expect(gpuSummary([{ name: "NVIDIA A100" }, { name: "NVIDIA A100" }])).toBe("2× NVIDIA A100");
    expect(gpuSummary([])).toBe("");
  });
});
