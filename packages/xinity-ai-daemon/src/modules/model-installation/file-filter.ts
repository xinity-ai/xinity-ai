/**
 * Gitignore-style file selection backed by Bun.Glob.
 *
 * Rules are processed in order. A leading "!" re-includes; everything else
 * excludes. The LAST matching rule wins. Files that match no rule at all
 * are excluded (allow-list semantics, mirroring vLLM's `allow_patterns`).
 *
 * Glob syntax follows Bun.Glob: `*` is path-segment, `**` is recursive,
 * `?` is single char, `[]` is char class, `{}` is brace expansion.
 */

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

/**
 * Builds the full ordered rule list for a repo: defaults (Mistral or HF),
 * optional `*.bin` fallback when no safetensors survive in HF mode, then
 * user-supplied overrides. User rules come last.
 */
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
