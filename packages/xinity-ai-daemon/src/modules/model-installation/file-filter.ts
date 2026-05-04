// Allow-list semantics (default exclude); a leading "!" re-includes; last
// matching rule wins. Globs are Bun.Glob.
interface CompiledRule {
  glob: Bun.Glob;
  negated: boolean;
}

function compile(rules: readonly string[]): CompiledRule[] {
  return rules.map((raw) => {
    const negated = raw.startsWith("!");
    return { glob: new Bun.Glob(negated ? raw.slice(1) : raw), negated };
  });
}

export function isIncluded(path: string, compiled: readonly CompiledRule[]): boolean {
  let included = false;
  for (const rule of compiled) {
    if (rule.glob.match(path)) included = rule.negated;
  }
  return included;
}

export function selectFiles<T extends { path: string }>(files: readonly T[], rules: readonly string[]): T[] {
  const compiled = compile(rules);
  return files.filter((f) => isIncluded(f.path, compiled));
}

const HF_DEFAULTS: readonly string[] = [
  "!*.safetensors",
  "!*.json",
  "!tokenizer.*",
  "!merges.txt",
  "!*.txt",
  "original/**",
  "*.gguf",
  "*.pt",
  "*.pth",
  "*.onnx",
  "*.msgpack",
  "*.h5",
];

const MISTRAL_DEFAULTS: readonly string[] = [
  "!consolidated*.safetensors",
  "!consolidated.safetensors.index.json",
  "!*.json",
  "!tokenizer.*",
  "!tekken.json",
  "!merges.txt",
  "!*.txt",
  "original/**",
];

const BIN_FALLBACK = "!*.bin";

export function isMistralRepo(paths: readonly string[]): boolean {
  return paths.some((p) => /^consolidated.*\.safetensors$/.test(p));
}

export function buildRules<T extends { path: string }>(
  files: readonly T[],
  userPatterns: readonly string[],
): { rules: string[]; mode: "mistral" | "hf" } {
  const paths = files.map((f) => f.path);
  if (isMistralRepo(paths)) {
    return { rules: [...MISTRAL_DEFAULTS, ...userPatterns], mode: "mistral" };
  }

  const baseRules = [...HF_DEFAULTS];
  const firstPass = selectFiles(files, [...baseRules, ...userPatterns]);
  const hasSafetensors = firstPass.some((f) => f.path.endsWith(".safetensors"));
  if (!hasSafetensors) baseRules.push(BIN_FALLBACK);

  return { rules: [...baseRules, ...userPatterns], mode: "hf" };
}
