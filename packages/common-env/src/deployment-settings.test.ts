import { describe, it, expect } from "bun:test";
import {
  mergeSettings,
  normalizeSettings,
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

describe("mergeSettings", () => {
  it("keeps both-unset unset", () => {
    expect(mergeSettings({ version: 1 }, { version: 1 })).toEqual({ version: 1 });
  });

  it("takes the one-sided value", () => {
    expect(mergeSettings({ version: 1, maxAudioInputDurationS: 900 }, { version: 1 }))
      .toEqual({ version: 1, maxAudioInputDurationS: 900 });
    expect(mergeSettings({ version: 1 }, { version: 1, maxAudioInputDurationS: 900 }))
      .toEqual({ version: 1, maxAudioInputDurationS: 900 });
  });

  it("takes the maximum when both are set", () => {
    expect(mergeSettings(
      { version: 1, maxAudioInputDurationS: 600 },
      { version: 1, maxAudioInputDurationS: 1800 },
    )).toEqual({ version: 1, maxAudioInputDurationS: 1800 });
  });

  it("handles maxAudioInputFileSizeMB", () => {
    expect(mergeSettings({ version: 1, maxAudioInputFileSizeMB: 50 }, { version: 1 }))
      .toEqual({ version: 1, maxAudioInputFileSizeMB: 50 });
    expect(mergeSettings({ version: 1 }, { version: 1, maxAudioInputFileSizeMB: 100 }))
      .toEqual({ version: 1, maxAudioInputFileSizeMB: 100 });
    expect(mergeSettings(
      { version: 1, maxAudioInputFileSizeMB: 50 },
      { version: 1, maxAudioInputFileSizeMB: 100 },
    )).toEqual({ version: 1, maxAudioInputFileSizeMB: 100 });
  });
});
