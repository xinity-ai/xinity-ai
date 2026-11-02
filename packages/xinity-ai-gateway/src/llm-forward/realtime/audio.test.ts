import { describe, expect, test } from "bun:test";
import { createPcmInput, encodePcm16 } from "./audio";

function tone(hz: number, rate: number, seconds: number, amplitude = 10_000): Int16Array<ArrayBuffer> {
  return Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate)));
}

function peak(samples: Int16Array, skip: number): number {
  return samples.subarray(skip, samples.length - skip).reduce((max, s) => Math.max(max, Math.abs(s)), 0);
}

describe("createPcmInput", () => {
  test("passes audio through when the rates match", () => {
    const samples = tone(440, 16_000, 0.1);
    expect(createPcmInput(16_000, 16_000).push(encodePcm16(samples))).toEqual(samples);
  });

  test("turns one second at 24 kHz into one second at 16 kHz", () => {
    const out = createPcmInput(24_000, 16_000).push(encodePcm16(tone(440, 24_000, 1)));
    expect(Math.abs(out.length - 16_000)).toBeLessThan(16);
  });

  test("gives the same output however the stream is chunked, including chunks that split a sample", () => {
    const bytes = Buffer.from(encodePcm16(tone(440, 24_000, 0.5)), "base64");
    const whole = createPcmInput(24_000, 16_000).push(bytes.toString("base64"));

    const chunked = createPcmInput(24_000, 16_000);
    const parts: number[] = [];
    for (let at = 0; at < bytes.length; at += 777) {
      parts.push(...chunked.push(bytes.subarray(at, at + 777).toString("base64")));
    }
    expect(Int16Array.from(parts)).toEqual(whole);
  });

  test("keeps speech-band tones and removes what 16 kHz cannot represent", () => {
    const kept = createPcmInput(24_000, 16_000).push(encodePcm16(tone(1_000, 24_000, 0.5)));
    const removed = createPcmInput(24_000, 16_000).push(encodePcm16(tone(10_000, 24_000, 0.5)));
    expect(peak(kept, 64)).toBeGreaterThan(9_500);
    expect(peak(removed, 64)).toBeLessThan(500);
  });
});
