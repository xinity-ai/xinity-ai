import { z } from "zod";
import { configBool, configInt, configNumber, expert, readLeafMeta, secret } from "common-env";

export type DynamicSetting = {
  key: string;
  components: string[];
  group?: string;
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
  {
    key: "SIGNUP_ENABLED",
    components: ["dashboard"],
    group: "Authentication",
    schema: configBool().default(true).describe("Enable user signup"),
  },
  {
    key: "DEPLOYMENT_STRATEGY",
    components: ["dashboard"],
    group: "Compute",
    schema: z.enum(["first-fit", "balanced", "bin-pack", "proportional"]).default("balanced")
      .describe("Node selection strategy for new model installations. 'first-fit' picks the first node that fits (deterministic). 'balanced' picks the node with the most absolute free VRAM (spread for HA). 'bin-pack' picks the tightest fit (consolidate so idle nodes stay drainable). 'proportional' picks the node with the lowest percent utilization (fair spread across heterogeneous nodes)."),
  },
  {
    key: "KEEPALIVE_INTERVAL_MS",
    components: ["tether"],
    group: "HTTP server",
    schema: configNumber().default(15_000)
      .describe("SSE keepalive interval in ms").meta(expert()),
  },
  {
    key: "LIVENESS_TIMEOUT_MS",
    components: ["tether"],
    group: "HTTP server",
    schema: configNumber().default(45_000)
      .describe("Time before a silent connection is considered dead").meta(expert()),
  },
  {
    key: "VLLM_HEALTH_TIMEOUT_MS",
    components: ["daemon"],
    group: "vLLM",
    schema: configNumber().default(60 * 60 * 1000)
      .describe("vLLM health check timeout in milliseconds (default: 1 hour)").meta(expert()),
  },
  {
    key: "VLLM_HEALTH_POLL_INTERVAL_MS",
    components: ["daemon"],
    group: "vLLM",
    schema: configNumber().default(5_000)
      .describe("vLLM health check poll interval in milliseconds").meta(expert()),
  },
  {
    key: "VLLM_MAX_RESTART_COUNT",
    components: ["daemon"],
    group: "vLLM",
    schema: configInt(z.int().positive()).default(3)
      .describe("Max container restarts before marking installation as permanently failed").meta(expert()),
  },
  {
    key: "VLLM_HF_TOKEN",
    components: ["daemon"],
    group: "vLLM",
    schema: z.string().optional()
      .describe("HuggingFace token for downloading private or gated models").meta(secret()),
  },
  {
    key: "MCP_ENABLED",
    components: ["dashboard"],
    schema: configBool().default(true)
      .describe("Enable the /mcp Model Context Protocol endpoint"),
  },
  {
    key: "LICENSE_KEY",
    components: ["dashboard"],
    schema: z.string().optional()
      .describe("License key for unlocking paid features (Ed25519-signed token)").meta(secret()),
  },
];

export function findDynamicSetting(key: string): DynamicSetting | undefined {
  return DYNAMIC_SETTINGS.find((setting) => setting.key === key);
}

export type DynamicGroupMember = { name: string; key: string; schema: z.ZodType };

/** Settings only meaningful as a set: written in one transaction and judged by one schema. */
export type DynamicGroup = {
  id: string;
  title: string;
  description: string;
  /** Consequences of turning this on that the setting itself cannot show. */
  warning?: string;
  components: string[];
  members: DynamicGroupMember[];
  /** Over `{ [member.name]: value }`, because no member schema can judge the others. */
  schema: z.ZodType;
};

const API_KEY_PROVIDERS = ["bing", "brave", "serper", "tavily"] as const;
const SEARCH_PROVIDERS = ["searxng", "google", ...API_KEY_PROVIDERS] as const;

export const DYNAMIC_GROUPS: DynamicGroup[] = [
  {
    id: "webSearch",
    title: "Web search",
    description: "Backend for web-search-augmented generation, and the credential it authenticates with.",
    warning: "Search queries leave your deployment: the provider you choose receives every search the "
      + "model runs. The model decides what to search for, so a query can carry content from a user's "
      + "conversation.",
    components: ["gateway"],
    members: [
      {
        name: "provider",
        key: "WEB_SEARCH_PROVIDER",
        schema: z.enum(SEARCH_PROVIDERS).describe("Web search backend"),
      },
      {
        name: "credential",
        key: "WEB_SEARCH_CREDENTIAL",
        schema: z.string().describe("searxng=instance URL, google=apikey:cx, others=API key").meta(secret()),
      },
    ],
    schema: z.discriminatedUnion("provider", [
      z.object({
        provider: z.literal("searxng"),
        credential: z.url({ message: "WEB_SEARCH_CREDENTIAL for searxng must be a valid URL" }),
      }),
      z.object({
        provider: z.literal("google"),
        credential: z.string().regex(/^[^:]+:.+$/, "WEB_SEARCH_CREDENTIAL for google must be in apikey:cx format"),
      }),
      ...API_KEY_PROVIDERS.map((provider) => z.object({
        provider: z.literal(provider),
        credential: z.string().trim()
          .min(1, `WEB_SEARCH_CREDENTIAL for ${provider} must be a non-empty API key`),
      })),
    ]),
  },
];

export function findDynamicGroup(id: string): DynamicGroup | undefined {
  return DYNAMIC_GROUPS.find((group) => group.id === id);
}

type JsonSchema = { type?: string; enum?: string[]; default?: unknown; description?: string };

/** The part of a setting that survives the wire, since a schema cannot be serialized. */
export type DynamicSettingSummary = {
  key: string;
  components: string[];
  group?: string;
  description: string;
  defaultValue?: string;
  isSecret: boolean;
  kind: "number" | "integer" | "boolean" | "string";
  enumValues?: string[];
};

type FieldShape = {
  description: string;
  defaultValue?: string;
  isSecret: boolean;
  kind: "number" | "integer" | "boolean" | "string";
  enumValues?: string[];
};

function shapeOf(schema: z.ZodType): FieldShape {
  const json = z.toJSONSchema(schema, { io: "output" }) as JsonSchema;
  return {
    description: json.description ?? "",
    defaultValue: json.default === undefined ? undefined : String(json.default),
    isSecret: readLeafMeta(schema).secret === true,
    kind: json.type === "number" || json.type === "integer" || json.type === "boolean" ? json.type : "string",
    enumValues: json.enum,
  };
}

export function summarize(setting: DynamicSetting): DynamicSettingSummary {
  return {
    key: setting.key,
    components: setting.components,
    group: setting.group,
    ...shapeOf(setting.schema),
  };
}

export type DynamicGroupSummary = {
  id: string;
  title: string;
  description: string;
  warning?: string;
  components: string[];
  members: ({ name: string; key: string } & FieldShape)[];
};

export function summarizeGroup(group: DynamicGroup): DynamicGroupSummary {
  return {
    id: group.id,
    title: group.title,
    description: group.description,
    warning: group.warning,
    components: group.components,
    members: group.members.map((member) => ({
      name: member.name,
      key: member.key,
      ...shapeOf(member.schema),
    })),
  };
}

/** Group members are not settings, so a lookup by key has to consider both to judge secrecy. */
export function isSecretKey(key: string): boolean {
  const setting = findDynamicSetting(key);
  if (setting) {
    return summarize(setting).isSecret;
  }
  const member = DYNAMIC_GROUPS.flatMap((group) => group.members).find((entry) => entry.key === key);
  return member !== undefined && readLeafMeta(member.schema).secret === true;
}
