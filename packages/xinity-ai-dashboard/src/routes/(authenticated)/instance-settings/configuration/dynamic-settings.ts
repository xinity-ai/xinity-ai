import { z } from "zod";
import { configInt, configNumber, expert, readLeafMeta } from "common-env";

export type DynamicSetting = {
  key: string;
  components: string[];
  group: string;
  schema: z.ZodType;
};

const ttl = (seconds: number) => configNumber(z.number().positive()).default(seconds).meta(expert());

/**
 * Mirrors every field a service declares with `dynamic()`, schema included, so a value is judged
 * here exactly as the service will judge it. Held rather than imported because the dashboard must
 * not depend on the other services; a test in `xinity-cli`, the one package that may import both,
 * compares the two and fails when they drift.
 */
export const DYNAMIC_SETTINGS: DynamicSetting[] = [
  {
    key: "CACHE_API_KEY_TTL_SECONDS",
    components: ["gateway"],
    group: "Cache",
    schema: ttl(120)
      .describe("How long a validated API key is cached, so every request does not hit the database"),
  },
  {
    key: "CACHE_APPLICATION_TTL_SECONDS",
    components: ["gateway"],
    group: "Cache",
    schema: ttl(300).describe("How long an application name to id lookup is cached"),
  },
  {
    key: "CACHE_AUTH_FAILURE_TTL_SECONDS",
    components: ["gateway"],
    group: "Cache",
    schema: ttl(10)
      .describe("How long a rejected API key is remembered. Short, so re-enabling a key takes effect promptly"),
  },
  {
    key: "CACHE_DIGEST_MAX_ENTRIES",
    components: ["gateway"],
    group: "Cache",
    schema: configInt(z.int().positive()).default(5_000)
      .describe("Entries held in the in-process chat message digest cache, which avoids re-hashing repeated history")
      .meta(expert()),
  },
  {
    key: "CACHE_MODEL_TTL_SECONDS",
    components: ["gateway"],
    group: "Cache",
    schema: ttl(60).describe("How long a model deployment lookup is cached"),
  },
  {
    key: "RESPONSE_CACHE_TTL_SECONDS",
    components: ["gateway"],
    group: "Cache",
    schema: ttl(3600)
      .describe("How long an identical completion is served from cache instead of the backend"),
  },
  {
    key: "BACKEND_TIMEOUT_MS",
    components: ["gateway"],
    group: "Inference backends",
    schema: configNumber(z.number().positive()).default(300_000)
      .describe("Backend timeout in ms (default: 5 min). For streaming requests this is an idle timeout that resets on each chunk; for non-streaming requests it is a wall-clock deadline."),
  },
  {
    key: "LOAD_BALANCE_STRATEGY",
    components: ["gateway"],
    group: "Inference backends",
    schema: z.enum(["random", "round-robin", "least-connections"]).default("least-connections")
      .describe("Load balancing strategy for distributing requests across inference nodes"),
  },
];

export function findDynamicSetting(key: string): DynamicSetting | undefined {
  return DYNAMIC_SETTINGS.find((setting) => setting.key === key);
}

type JsonSchema = { type?: string; enum?: string[]; default?: unknown; description?: string };

/** The part of a setting that survives the wire, since a schema cannot be serialized. */
export type DynamicSettingSummary = {
  key: string;
  components: string[];
  group: string;
  description: string;
  defaultValue?: string;
  isSecret: boolean;
  kind: "number" | "integer" | "boolean" | "string";
  enumValues?: string[];
};

export function summarize(setting: DynamicSetting): DynamicSettingSummary {
  const json = z.toJSONSchema(setting.schema, { io: "output" }) as JsonSchema;
  const kind = json.type === "number" || json.type === "integer" || json.type === "boolean"
    ? json.type
    : "string";

  return {
    key: setting.key,
    components: setting.components,
    group: setting.group,
    description: json.description ?? "",
    defaultValue: json.default === undefined ? undefined : String(json.default),
    isSecret: readLeafMeta(setting.schema).secret === true,
    kind,
    enumValues: json.enum,
  };
}
