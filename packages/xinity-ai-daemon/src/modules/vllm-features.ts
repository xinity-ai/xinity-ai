import { $ } from "bun";
import { dirname, join } from "node:path";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "vllm-features" });

const FEATURE_PROBES = [
  { slug: "audio", pythonModule: "soundfile" },
  { slug: "vllm-omni", pythonModule: "vllm_omni" },
] as const;

type FeatureSlug = (typeof FEATURE_PROBES)[number]["slug"];

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const SHEBANG_MAGIC = [0x23, 0x21];
const PYTHON_BIN_RE = /\/python3(?:\.\d+)?$/;

function bytesMatch(buf: Uint8Array, prefix: number[]): boolean {
  return prefix.every((b, i) => buf[i] === b);
}

function parseShebangInterpreter(text: string): string | null {
  const firstLine = text.split("\n")[0] ?? "";
  if (!firstLine.startsWith("#!")) {
    return null;
  }
  const interpreter = firstLine.slice(2).trim();
  if (interpreter.startsWith("/usr/bin/env ")) {
    return interpreter.slice("/usr/bin/env ".length).trim();
  }
  return interpreter || null;
}

function findEmbeddedPythonPath(binaryContent: string): string | null {
  for (const segment of binaryContent.split("\0")) {
    if (segment.length < 4) {
      continue;
    }

    if (segment.startsWith("/") && PYTHON_BIN_RE.test(segment)) {
      return segment;
    }

    const eq = segment.indexOf("=");
    if (eq > 0) {
      const value = segment.slice(eq + 1);
      if (value.startsWith("/") && PYTHON_BIN_RE.test(value)) {
        return value;
      }
    }
  }
  return null;
}

export async function resolvePythonForVllm(vllmPath: string): Promise<string> {
  try {
    const file = Bun.file(vllmPath);
    const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());

    if (bytesMatch(magic, SHEBANG_MAGIC)) {
      const head = await file.slice(0, 512).text();
      const interpreter = parseShebangInterpreter(head);
      if (interpreter) {
        return interpreter;
      }
    }

    if (bytesMatch(magic, ELF_MAGIC)) {
      const raw = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      const decoded = new TextDecoder("latin1" as Bun.Encoding).decode(raw);
      const pythonPath = findEmbeddedPythonPath(decoded);
      if (pythonPath) {
        return pythonPath;
      }
    }
  } catch (err) {
    log.debug({ err, vllmPath }, "Could not determine Python for vllm binary");
  }

  return join(dirname(vllmPath), "python3");
}

async function probeImport(
  pythonBin: string,
  pythonModule: string,
  dockerImage?: string,
): Promise<boolean> {
  try {
    if (dockerImage) {
      const { exitCode } = await $`docker run --rm --entrypoint python3 ${dockerImage} -c ${"import " + pythonModule}`.throws(false).quiet();
      return exitCode === 0;
    }
    const { exitCode } = await $`${pythonBin} -c ${"import " + pythonModule}`.throws(false).quiet();
    return exitCode === 0;
  } catch (err) {
    log.debug({ err, pythonBin, pythonModule }, "Feature probe failed");
    return false;
  }
}

export async function detectVllmFeatures(
  source: "docker" | "binary",
  opts: { dockerImage?: string; vllmPath?: string },
): Promise<string[]> {
  let pythonBin = "python3";
  if (source === "binary" && opts.vllmPath) {
    pythonBin = await resolvePythonForVllm(opts.vllmPath);
    log.debug({ vllmPath: opts.vllmPath, pythonBin }, "Resolved Python for vLLM binary");
  }

  const results = await Promise.all(
    FEATURE_PROBES.map(async ({ slug, pythonModule }) => {
      const present = await probeImport(pythonBin, pythonModule, source === "docker" ? opts.dockerImage : undefined);
      return present ? slug : null;
    }),
  );
  const features = results.filter((s): s is FeatureSlug => s !== null);
  if (features.length > 0) {
    log.info({ features, source, pythonBin }, "Detected vLLM optional features");
  }
  return features;
}
