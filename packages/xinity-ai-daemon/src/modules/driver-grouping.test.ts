import { describe, test, expect } from "bun:test";
import { groupInstallationsByDriver } from "./driver-grouping";

// ---------------------------------------------------------------------------
// groupInstallationsByDriver
// ---------------------------------------------------------------------------

describe("groupInstallationsByDriver", () => {
  test("groups installations by driver", () => {
    const installations = [
      { id: "1", model: "llama3", driver: "ollama" },
      { id: "2", model: "mistral", driver: "ollama" },
      { id: "3", model: "codellama", driver: "vllm" },
    ];
    const groups = groupInstallationsByDriver(installations);
    expect(groups).toHaveLength(2);

    const ollama = groups.find((g) => g.driver === "ollama");
    const vllm = groups.find((g) => g.driver === "vllm");
    expect(ollama).toBeDefined();
    expect(ollama!.installations).toHaveLength(2);
    expect(vllm).toBeDefined();
    expect(vllm!.installations).toHaveLength(1);
  });

  test("returns empty array for empty input", () => {
    const groups = groupInstallationsByDriver([]);
    expect(groups).toEqual([]);
  });

  test("handles single driver", () => {
    const installations = [
      { id: "1", model: "a", driver: "ollama" },
      { id: "2", model: "b", driver: "ollama" },
    ];
    const groups = groupInstallationsByDriver(installations);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.driver).toBe("ollama");
    expect(groups[0]!.installations).toHaveLength(2);
  });

  test("handles many distinct drivers", () => {
    const installations = [
      { id: "1", model: "a", driver: "ollama" },
      { id: "2", model: "b", driver: "vllm" },
      { id: "3", model: "c", driver: "custom" },
    ];
    const groups = groupInstallationsByDriver(installations);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.driver).sort()).toEqual(["custom", "ollama", "vllm"]);
  });

  test("preserves installation objects in groups", () => {
    const installations = [
      { id: "x", model: "phi", driver: "ollama", extra: 42 },
    ];
    const groups = groupInstallationsByDriver(installations);
    expect(groups[0]!.installations[0]).toBe(installations[0]);
  });
});
