/**
 * Vocabulary shared by the model formats. Lives apart from either schema so the
 * deprecated v1 definition can be deleted without taking v2's building blocks
 * with it.
 */
import { z } from "zod";

export const EngineEnum = z.enum(["vllm", "ollama"]);
export type Engine = z.infer<typeof EngineEnum>;

export const TagEnum = z.enum(["tools", "custom_code", "vision"]);
export type Tag = z.infer<typeof TagEnum>;

export const GpuVendorEnum = z.enum(["nvidia", "amd", "intel"]);
export type GpuVendor = z.infer<typeof GpuVendorEnum>;

export const ModelTypeEnum = z.enum(["embedding", "chat", "rerank", "transcription"]);
export type ModelType = z.infer<typeof ModelTypeEnum>;

/** Allowed primitive type names for requestParams values. */
export const RequestParamTypeEnum = z.enum(["boolean", "number", "string"]);
export type RequestParamType = z.infer<typeof RequestParamTypeEnum>;

const MODEL_DATE_PATTERN = /^\d{4}[.-]\d{2}[.-]\d{2}$/;

function isRealCalendarDate(isoDate: string): boolean {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(isoDate);
}

/** The catalog was authored as `2026.05.05` for months, so both separators parse. */
export const ModelDate = z.string()
  .regex(MODEL_DATE_PATTERN, "Expected a date as YYYY-MM-DD")
  .transform(value => value.replaceAll(".", "-"))
  .refine(isRealCalendarDate, "Not a real calendar date");

/**
 * vLLM args that must not appear in model definitions because they are either
 * auto-derived from tags or managed by the system.
 */
export const BLOCKED_VLLM_ARGS = new Set([
  "--trust-remote-code",       // controlled by custom_code tag
  "--enable-auto-tool-choice", // auto-derived from tools tag
  "--runner",                  // auto-derived from model type (embedding/rerank → pooling)
  "--task",                    // deprecated in favor of --runner, auto-managed
  "--host",                    // system-managed
  "--port",                    // system-managed
  "--served-model-name",       // system-managed
  "--kv-cache-memory-bytes",   // system-managed via kvCacheCapacity
  "--gpu-memory-utilization",  // system-managed, calculated from model needs and total VRAM
  "--api-key",                 // system-managed
]);

/**
 * Request-level parameter paths that must never be forwarded to backends,
 * regardless of model configuration. Defense-in-depth against known CVEs.
 */
export const BLOCKED_REQUEST_PARAM_PREFIXES = [
  "chat_template",  // Jinja injection vector (CVE-2025-61620), note: chat_template_kwargs is fine
  "tokenize",       // DoS vector (CVE-2025-62426)
  "prompt",         // prompt override
  "api_key",        // credential leak
];

type NestedStringItem = string | NestedStringItem[];
const nestedStringItem: z.ZodType<NestedStringItem> = z.lazy(() =>
  z.union([z.string(), z.array(nestedStringItem)])
);

/** Deeply flattened so YAML anchors can be spliced into an arg list. */
export const flatStringArray = z.array(nestedStringItem)
  .transform((arr): string[] => (arr as unknown[]).flat(Infinity) as string[])
  .pipe(z.array(z.string()));

/** Drops blocked flags along with their values. */
export function stripBlockedVllmArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (BLOCKED_VLLM_ARGS.has(arg)) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        i++;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

export function hasBlockedRequestParam(paths: Iterable<string>): boolean {
  for (const dotPath of paths) {
    const [prefix = ""] = dotPath.split(".");
    if (BLOCKED_REQUEST_PARAM_PREFIXES.includes(prefix)) {
      return true;
    }
  }
  return false;
}
