import { type InferSelectModel, sql } from "drizzle-orm";
import { pgEnum, pgTable, real, text, timestamp, uuid, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";

export const lifecycleStateEnum = pgEnum("lifecycle_state", ["downloading", "installing", "ready", "failed"]);
export const inferenceDriverEnum = pgEnum("inference_driver", ["ollama", "vllm"]);

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());
const deletedAt = timestamp("deleted_at", { withTimezone: true });
const organizationId = text("organization_id")
  .notNull()
  .references(() => organizationT.id, { onDelete: "restrict" });

/** This table lists currently deployed models.
 *
 * This represents the "should" state of the system, describing what models are expected to be deployed for a user, but not what actually exist.
 * For that, check the server specific modelInstallation table
 */
export const modelDeploymentT = pgTable("model_deployment", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId,
  name: text().notNull(),

  description: text(),
  enabled: boolean().notNull().default(true),
  /** The deployment is available for usage under that name.
   * The underlying model may be named differently.
   * This indirection enables project scoping, and canary deployments.
   * Tbs, by default it will simply reflect the specifier of the deployed model */
  publicSpecifier: text("public_specifier").notNull(),
  /** Canonical model identifier (infoserver publicSpecifier today; per-org custom model id in the future).
   * Used for all infoserver lookups and deployment ↔ installation joins. Nullable for legacy rows
   * created before this column existed; new rows always populate it. */
  specifier: text(),
  /** Canary counterpart of {@link specifier}. */
  earlySpecifier: text("early_specifier"),
  /** @deprecated Use {@link specifier}. This is the driver-specific provider string and is preserved
   * only for back-compat with rows that pre-date the specifier migration, and as the model name actually
   * passed to vLLM/Ollama at launch time. */
  modelSpecifier: text("model_specifier").notNull(),
  /** @deprecated Use {@link earlySpecifier}. See {@link modelSpecifier}. */
  earlyModelSpecifier: text("early_model_specifier"),
  replicas: integer().notNull().default(1),
  /** When present, marks the point at which progress should reach 100 */
  canaryProgressUntil: timestamp("canary_progress_until", { withTimezone: true }),
  /** When present, marks the start of canary progress modification. Usually equal to updatedAt */
  canaryProgressFrom: timestamp("canary_progress_from", { withTimezone: true }),
  canaryProgressWithFeedback: boolean("canary_progress_with_feedback").notNull().default(false),
  progress: integer().notNull().default(100),
  /** User-specified KV-cache in GB. Null means use the model's default minKvCache. */
  kvCacheSize: real("kv_cache_size"),
  /** User-specified KV-cache in GB for the canary (early) model. Null means use the early model's default minKvCache. */
  earlyKvCacheSize: real("early_kv_cache_size"),
  /** User-specified preferred inference driver. Null means auto (system default). */
  preferredDriver: inferenceDriverEnum("preferred_driver"),

  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  uniqueIndex("model_deployment_public_specifier_organization_id_idx")
    .on(table.publicSpecifier, table.organizationId)
    .where(sql`${table.deletedAt} IS NULL`),
  index("model_deployment_deleted_at_idx").on(table.deletedAt),
]);
export type ModelDeployment = InferSelectModel<typeof modelDeploymentT>;

/**
 * Represents a known ai node, incl. its reachable ip in the system, estimated capacity and links to models deployed on it
 */
export const aiNodeT = pgTable("ai_node", {
  id: uuid().primaryKey().defaultRandom(),
  host: text().notNull(),
  port: integer().notNull(),
  /** estimated capacity available on the node, as GB of estimated usable model capacity */
  estCapacity: real("est_capacity").notNull(),
  available: boolean().notNull().default(true),
  /** Represents drivers supported on this node */
  drivers: text().array().notNull().default(["ollama"]),
  /** Number of GPUs detected on this node. 0 means CPU-only. */
  gpuCount: integer("gpu_count").notNull().default(0),
  /** Maps driver name to its detected version string, e.g. {"vllm": "0.19.1", "ollama": "0.6.3"} */
  driverVersions: jsonb("driver_versions").$type<Record<string, string>>().notNull().default({}),
  /** Detected GPUs with vendor, name, and VRAM. Empty = unknown/CPU-only. */
  gpus: jsonb().$type<{ vendor: string; name: string; vramMb: number }[]>().notNull().default([]),
  /** Random token generated on daemon startup, used by the gateway to authenticate requests to this node. */
  authToken: text("auth_token"),
  /** Whether this node serves over TLS. Set by the daemon based on its config. */
  tls: boolean().notNull().default(false),

  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  index("ai_node_deleted_at_idx").on(table.deletedAt),
  uniqueIndex("ai_node_host_port_idx")
    .on(table.host, table.port)
    .where(sql`${table.deletedAt} IS NULL`),
]);
export type AiNode = InferSelectModel<typeof aiNodeT>;

export const modelInstallationT = pgTable("model_installation", {
  id: uuid().primaryKey().defaultRandom(),
  nodeId: uuid("node_id").notNull().references(() => aiNodeT.id, { onDelete: "cascade" }),
  /** Canonical model identifier (see {@link modelDeploymentT.specifier}). Nullable for legacy
   * installations; new installations always populate it. */
  specifier: text(),
  /** @deprecated Use {@link specifier} for catalog identity. This is the driver-specific provider
   * string actually passed to vLLM/Ollama at launch and is preserved both for back-compat and as
   * the value the daemon needs to invoke the underlying server. */
  model: text().notNull(),
  /** estimated total GPU capacity required (model weights + KV cache), taken up on the selected node */
  estCapacity: real("est_capacity").notNull(),
  /** KV-cache allocation in GB, used by the daemon for vLLM's --kv-cache-memory-bytes */
  kvCacheCapacity: real("kv_cache_capacity").notNull().default(0),
  /** @deprecated Internal to the daemon. The gateway routes through the daemon proxy and does not use this field. */
  port: integer().notNull(),
  driver: inferenceDriverEnum().notNull(),

  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  index("model_installation_node_id_idx").on(table.nodeId),
  index("model_installation_specifier_idx").on(table.specifier),
  index("model_installation_model_idx").on(table.model),
  index("model_installation_deleted_at_idx").on(table.deletedAt),
]);
export type ModelInstallation = InferSelectModel<typeof modelInstallationT>;

/**
 * Represents known additional info about any particular model installation. This is a 1-on-1 mapping, but kept
 * in a separate table 1. since changes to modelInstallation itself should function as a signal for ai nodes to act upon
 * and 2. to be independently writable by ai nodes, without having to update the installation itself
 */
export const modelInstallationStateT = pgTable("model_installation_state", {
  id: uuid().primaryKey().references(() => modelInstallationT.id, { onDelete: "cascade" }),

  lifecycleState: lifecycleStateEnum("lifecycle_state").notNull(),
  /** In some phases there may be a progress indicator for the installation. It may also just be null */
  progress: real(),
  /** In case of an error or a restart, this message would presumably be filled */
  errorMessage: text("error_message"),
  /** Potential driver provided status message. Empty in most cases */
  statusMessage: text("status_message"),
  /** Raw container/service logs captured on failure, for user diagnostics */
  failureLogs: text("failure_logs"),

  createdAt,
  updatedAt,
});
