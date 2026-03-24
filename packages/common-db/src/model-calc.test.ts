import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { calcCanaryProgress } from "./model-calc";
import type { ModelDeployment } from "./schema/models";

function makeDeployment(overrides: Partial<ModelDeployment> = {}): ModelDeployment {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organizationId: "org-1",
    name: "test-deployment",
    description: null,
    enabled: true,
    publicSpecifier: "test-model",
    modelSpecifier: "new-model",
    earlyModelSpecifier: "old-model",
    replicas: 1,
    progress: 50,
    canaryProgressFrom: null,
    canaryProgressUntil: null,
    canaryProgressWithFeedback: false,
    kvCacheSize: null,
    preferredDriver: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Use a fixed "now" anchored in the middle of all test windows so
// relative offsets are deterministic and dates don't drift into the past.
const FIXED_NOW = new Date("2030-01-15T12:00:00Z").valueOf();

describe("calcCanaryProgress", () => {
  let nowSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    nowSpy = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  });
  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("returns 100 when progress is already 100", () => {
    const d = makeDeployment({ progress: 100, earlyModelSpecifier: "old" });
    expect(calcCanaryProgress(d)).toBe(100);
  });

  it("returns 100 when earlyModelSpecifier is null (not a canary)", () => {
    const d = makeDeployment({ earlyModelSpecifier: null, progress: 30 });
    expect(calcCanaryProgress(d)).toBe(100);
  });

  it("returns 100 when canaryProgressUntil is in the past", () => {
    const past = new Date(FIXED_NOW - 60_000);
    const d = makeDeployment({ canaryProgressUntil: past });
    expect(calcCanaryProgress(d)).toBe(100);
  });

  it("returns static progress when canaryProgressFrom is missing", () => {
    const future = new Date(FIXED_NOW + 3_600_000);
    const d = makeDeployment({
      progress: 30,
      canaryProgressFrom: null,
      canaryProgressUntil: future,
    });
    expect(calcCanaryProgress(d)).toBe(30);
  });

  it("returns static progress when canaryProgressUntil is missing", () => {
    const past = new Date(FIXED_NOW - 60_000);
    const d = makeDeployment({
      progress: 30,
      canaryProgressFrom: past,
      canaryProgressUntil: null,
    });
    expect(calcCanaryProgress(d)).toBe(30);
  });

  it("returns static progress when totalDuration is zero (start === end)", () => {
    const t = new Date(FIXED_NOW + 1000);
    const d = makeDeployment({
      progress: 40,
      canaryProgressFrom: t,
      canaryProgressUntil: t,
    });
    nowSpy.mockReturnValue(t.valueOf());
    expect(calcCanaryProgress(d)).toBe(40);
  });

  it("returns static progress when start is after end (negative duration)", () => {
    const d = makeDeployment({
      progress: 40,
      canaryProgressFrom: new Date(FIXED_NOW + 2_000_000),
      canaryProgressUntil: new Date(FIXED_NOW + 1_000_000),
    });
    // now must be before canaryProgressUntil to pass the early-return check
    nowSpy.mockReturnValue(FIXED_NOW + 500_000);
    expect(calcCanaryProgress(d)).toBe(40);
  });

  it("returns initial progress at the very start of the window", () => {
    const from = new Date(FIXED_NOW);
    const until = new Date(FIXED_NOW + 86_400_000); // +1 day
    const d = makeDeployment({ progress: 20, canaryProgressFrom: from, canaryProgressUntil: until });
    nowSpy.mockReturnValue(from.valueOf());
    expect(calcCanaryProgress(d)).toBe(20);
  });

  it("interpolates to midpoint at half the window", () => {
    const from = new Date(FIXED_NOW);
    const until = new Date(FIXED_NOW + 86_400_000); // +1 day
    const d = makeDeployment({ progress: 0, canaryProgressFrom: from, canaryProgressUntil: until });
    // Midpoint: progress + (100 - 0) * 0.5 = 50
    nowSpy.mockReturnValue(from.valueOf() + 43_200_000);
    expect(calcCanaryProgress(d)).toBe(50);
  });

  it("caps interpolated value at 99 near the end of the window", () => {
    const from = new Date(FIXED_NOW);
    const until = new Date(FIXED_NOW + 86_400_000);
    const d = makeDeployment({ progress: 0, canaryProgressFrom: from, canaryProgressUntil: until });
    // 1ms before end: elapsed/total ≈ 1.0, interpolated ≈ 100 → capped at 99
    nowSpy.mockReturnValue(until.valueOf() - 1);
    expect(calcCanaryProgress(d)).toBeLessThanOrEqual(99);
    expect(calcCanaryProgress(d)).toBeGreaterThan(98);
  });

  it("handles progress starting at 0 with full date range", () => {
    const from = new Date(FIXED_NOW);
    const until = new Date(FIXED_NOW + 3_600_000); // +1 hour
    const d = makeDeployment({ progress: 0, canaryProgressFrom: from, canaryProgressUntil: until });
    // 30 minutes in: progress + (100 - 0) * 0.5 = 50
    nowSpy.mockReturnValue(from.valueOf() + 1_800_000);
    expect(calcCanaryProgress(d)).toBe(50);
  });

  it("clamps elapsed to 0 when now is before the start", () => {
    const from = new Date(FIXED_NOW + 60_000);
    const until = new Date(FIXED_NOW + 86_400_000);
    const d = makeDeployment({ progress: 20, canaryProgressFrom: from, canaryProgressUntil: until });
    nowSpy.mockReturnValue(from.valueOf() - 60_000);
    // elapsed clamped to 0 → interpolated = progress = 20
    expect(calcCanaryProgress(d)).toBe(20);
  });
});
