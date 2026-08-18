import { describe, test, expect } from "bun:test";
import type { IncompatibilityReason, ModelWithSpecifier } from "xinity-infoserver";
import { groupModelVariants, groupIncompatibility } from "./model-groups";

function makeModel(publicSpecifier: string, variantOf?: string): ModelWithSpecifier {
  return { publicSpecifier, variantOf } as ModelWithSpecifier;
}

const leader = makeModel("qwen3-27b-vllm");
const fp8 = makeModel("qwen3-27b-fp8-vllm", "qwen3-27b-vllm");
const [group] = groupModelVariants([leader, fp8]);

function reasons(bySpecifier: Record<string, IncompatibilityReason | null>) {
  return (model: ModelWithSpecifier) => bySpecifier[model.publicSpecifier] ?? null;
}

describe("groupIncompatibility", () => {
  test("clears the group when a variant other than the leader is deployable", () => {
    expect(groupIncompatibility(group, reasons({
      "qwen3-27b-vllm": "insufficient_capacity",
      "qwen3-27b-fp8-vllm": null,
    }))).toBeNull();
  });

  test("blocks the group only when every variant is blocked", () => {
    expect(groupIncompatibility(group, reasons({
      "qwen3-27b-vllm": "insufficient_capacity",
      "qwen3-27b-fp8-vllm": "insufficient_capacity",
    }))).toBe("insufficient_capacity");
  });

  test("reports the variant that came closest, not the leader's reason", () => {
    expect(groupIncompatibility(group, reasons({
      "qwen3-27b-vllm": "missing_driver",
      "qwen3-27b-fp8-vllm": "insufficient_capacity",
    }))).toBe("insufficient_capacity");
  });
});
