import { describe, it, expect } from "bun:test";
import {
  normalizeSettings,
  resolveOptimizeFor,
  settingsEqual,
} from "./deployment-settings";

describe("normalizeSettings", () => {
  it("drops the version discriminant", () => {
    expect(normalizeSettings({ version: 1 })).toEqual({});
  });

  it("drops unset fields and keeps set ones", () => {
    expect(normalizeSettings({ version: 1, maxAudioInputDurationS: 1200 }))
      .toEqual({ maxAudioInputDurationS: 1200 });
    expect(normalizeSettings({ version: 1, maxAudioInputDurationS: undefined })).toEqual({});
  });
});

describe("settingsEqual", () => {
  it("treats empty v1 objects as equal (legacy rows vs computed defaults)", () => {
    expect(settingsEqual({ version: 1 }, { version: 1 })).toBe(true);
  });

  it("detects a set value differing from unset", () => {
    expect(settingsEqual({ version: 1, maxAudioInputDurationS: 1200 }, { version: 1 })).toBe(false);
    expect(settingsEqual({ version: 1 }, { version: 1, maxAudioInputDurationS: 1200 })).toBe(false);
  });

  it("compares set values", () => {
    expect(settingsEqual(
      { version: 1, maxAudioInputDurationS: 1200 },
      { version: 1, maxAudioInputDurationS: 1200 },
    )).toBe(true);
    expect(settingsEqual(
      { version: 1, maxAudioInputDurationS: 1200 },
      { version: 1, maxAudioInputDurationS: 600 },
    )).toBe(false);
  });
});

describe("optimizeFor", () => {
  it("treats a stated space as the unset default, so choosing it causes no reinstall", () => {
    expect(settingsEqual({ version: 1, optimizeFor: "space" }, { version: 1 })).toBe(true);
    expect(settingsEqual({ version: 1, optimizeFor: "speed" }, { version: 1 })).toBe(false);
  });

  it("resolves an unset or unknown-version goal to space", () => {
    expect(resolveOptimizeFor({ version: 1 })).toBe("space");
    expect(resolveOptimizeFor(null)).toBe("space");
    expect(resolveOptimizeFor({ version: 1, optimizeFor: "speed" })).toBe("speed");
  });
});
