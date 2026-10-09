import { describe, it, expect } from "bun:test";
import { classifyGpu, gpuClassPatterns } from "./gpu-classes";

describe("gpu classes", () => {
  it("never lets a shorter pattern shadow a longer one containing it", () => {
    const shadowed = gpuClassPatterns.flatMap((pattern, index) =>
      gpuClassPatterns
        .slice(index + 1)
        .filter(later => later.includes(pattern))
        .map(later => `${pattern} shadows ${later}`),
    );

    expect(shadowed).toEqual([]);
  });

  it("reports an unlisted card as unknown rather than guessing a class", () => {
    expect(classifyGpu("NVIDIA GeForce GTX 1080").known).toBe(false);
  });
});
