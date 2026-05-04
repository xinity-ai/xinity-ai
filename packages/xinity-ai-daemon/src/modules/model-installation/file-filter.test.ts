import { describe, test, expect } from "bun:test";
import { selectFiles, buildRules, isMistralRepo } from "./file-filter";

function f(...paths: string[]): { path: string }[] {
  return paths.map((path) => ({ path }));
}

function names(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("isMistralRepo", () => {
  test("detects consolidated.safetensors", () => {
    expect(isMistralRepo(["consolidated.safetensors", "params.json"])).toBe(true);
  });

  test("detects sharded consolidated files", () => {
    expect(isMistralRepo(["consolidated-00001-of-00002.safetensors"])).toBe(true);
  });

  test("does not match plain HF sharded layout", () => {
    expect(isMistralRepo(["model-00001-of-00002.safetensors", "config.json"])).toBe(false);
  });

  test("does not match consolidated under a subdirectory", () => {
    expect(isMistralRepo(["original/consolidated.00.pth"])).toBe(false);
  });
});

describe("buildRules / selectFiles - HF default mode", () => {
  test("keeps sharded safetensors and json, drops original/, gguf, pth", () => {
    const files = f(
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "model.safetensors.index.json",
      "config.json",
      "tokenizer.json",
      "tokenizer.model",
      "original/consolidated.00.pth",
      "original/tokenizer.model",
      "model.gguf",
      "model.pt",
      "weights.h5",
      "README.md",
      "image.png",
    );

    const { rules, mode } = buildRules(files, []);
    expect(mode).toBe("hf");

    expect(names(selectFiles(files, rules))).toEqual([
      "config.json",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "model.safetensors.index.json",
      "tokenizer.json",
      "tokenizer.model",
    ]);
  });

  test("bin fallback kicks in when no safetensors are present", () => {
    const files = f(
      "pytorch_model-00001-of-00002.bin",
      "pytorch_model-00002-of-00002.bin",
      "config.json",
      "tokenizer.model",
      "model.gguf",
    );

    const { rules } = buildRules(files, []);

    expect(names(selectFiles(files, rules))).toEqual([
      "config.json",
      "pytorch_model-00001-of-00002.bin",
      "pytorch_model-00002-of-00002.bin",
      "tokenizer.model",
    ]);
  });

  test("does not enable bin fallback when safetensors exist", () => {
    const files = f("model.safetensors", "pytorch_model.bin", "config.json");
    const { rules } = buildRules(files, []);
    expect(names(selectFiles(files, rules))).toEqual(["config.json", "model.safetensors"]);
  });
});

describe("buildRules / selectFiles - Mistral mode", () => {
  test("keeps consolidated, drops sharded HF safetensors", () => {
    const files = f(
      "consolidated.safetensors",
      "consolidated.safetensors.index.json",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "params.json",
      "tokenizer.model",
      "tekken.json",
      "original/consolidated.00.pth",
    );

    const { rules, mode } = buildRules(files, []);
    expect(mode).toBe("mistral");

    expect(names(selectFiles(files, rules))).toEqual([
      "consolidated.safetensors",
      "consolidated.safetensors.index.json",
      "params.json",
      "tekken.json",
      "tokenizer.model",
    ]);
  });

  test("multi-shard consolidated repos keep all consolidated shards", () => {
    const files = f(
      "consolidated-00001-of-00003.safetensors",
      "consolidated-00002-of-00003.safetensors",
      "consolidated-00003-of-00003.safetensors",
      "params.json",
    );
    const { rules } = buildRules(files, []);
    expect(names(selectFiles(files, rules))).toEqual([
      "consolidated-00001-of-00003.safetensors",
      "consolidated-00002-of-00003.safetensors",
      "consolidated-00003-of-00003.safetensors",
      "params.json",
    ]);
  });
});

describe("user override patterns", () => {
  test("user pattern can drop a file the defaults would keep", () => {
    const files = f("model.safetensors", "config.json", "tokenizer.json");
    const { rules } = buildRules(files, ["*.json"]);
    expect(names(selectFiles(files, rules))).toEqual(["model.safetensors"]);
  });

  test("user negation re-includes a default-dropped file", () => {
    const files = f("model.safetensors", "config.json", "model.gguf");
    const { rules } = buildRules(files, ["!*.gguf"]);
    expect(names(selectFiles(files, rules))).toEqual([
      "config.json",
      "model.gguf",
      "model.safetensors",
    ]);
  });

  test("user can force HF mode by negating consolidated in a Mistral repo", () => {
    const files = f(
      "consolidated.safetensors",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "params.json",
    );
    const { rules, mode } = buildRules(files, ["!*.safetensors", "consolidated*.safetensors"]);
    expect(mode).toBe("mistral");

    expect(names(selectFiles(files, rules))).toEqual([
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "params.json",
    ]);
  });

  test("last match wins (user order matters)", () => {
    const files = f("model.gguf");
    const reInclude = buildRules(files, ["!*.gguf"]);
    expect(names(selectFiles(files, reInclude.rules))).toEqual(["model.gguf"]);

    const reExclude = buildRules(files, ["!*.gguf", "*.gguf"]);
    expect(names(selectFiles(files, reExclude.rules))).toEqual([]);
  });
});

describe("nested paths", () => {
  test("original/** matches subdirectories at any depth", () => {
    const files = f(
      "original/consolidated.00.pth",
      "original/sub/dir/file.bin",
      "original/tokenizer.model",
      "model.safetensors",
    );
    const { rules } = buildRules(files, []);
    expect(names(selectFiles(files, rules))).toEqual(["model.safetensors"]);
  });
});
