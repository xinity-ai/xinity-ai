import { describe, test, expect } from "bun:test";
import { groupInstallationsByDriver } from "./driver-grouping";

describe("groupInstallationsByDriver", () => {
  test("groups installations by driver", () => {
    const installations = [
      { id: "1", model: "llama3", driver: "ollama" },
      { id: "2", model: "mistral", driver: "ollama" },
      { id: "3", model: "codellama", driver: "vllm" },
    ];
    const groups = groupInstallationsByDriver(installations);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.driver === "ollama")!.installations).toHaveLength(2);
    expect(groups.find((g) => g.driver === "vllm")!.installations).toHaveLength(1);
  });

  test("preserves installation object identity in groups", () => {
    const installations = [{ id: "x", model: "phi", driver: "ollama", extra: 42 }];
    const groups = groupInstallationsByDriver(installations);
    expect(groups[0]!.installations[0]).toBe(installations[0]);
  });
});
