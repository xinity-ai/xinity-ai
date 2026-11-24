import { type InferSelectModel, sql } from "drizzle-orm";
import { pgEnum, pgTable, real, text, timestamp, uuid, boolean, integer, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { organizationT } from "./orgSchema";
import { DEPLOYMENT_TYPES, GROUP_STAGES, type DeploymentSettings, type RolloutAdvance, type GpuInfo, type InstallationGroup, type InterconnectPort } from "common-env";

export const lifecycleStateEnum = pgEnum("lifecycle_state", ["downloading", "installing", "ready", "failed"]);
export const inferenceDriverEnum = pgEnum("inference_driver", ["ollama", "vllm"]);
export const groupStageEnum = pgEnum("group_stage", GROUP_STAGES);
export const deploymentTypeEnum = pgEnum("deployment_type", DEPLOYMENT_TYPES);

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());
const deletedAt = timestamp("deleted_at", { withTimezone: true });
const organizationId = text("organization_id")
  .notNull()
  .references(() => organizationT.id, { onDelete: "restrict" });

/** A deployment as users see and address it. What serves it is the row of its `type`. */
export const deploymentT = pgTable("deployment", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId,
  name: text().notNull(),

  description: text(),
  enabled: boolean().notNull().default(true),
  /** The name clients request the deployment by, unique within the organization. */
  publicSpecifier: text("public_specifier").notNull(),
  type: deploymentTypeEnum().notNull(),
  legacyId: uuid("legacy_id").references(() => deploymentLegacyT.id),
  managedId: uuid("managed_id").references(() => deploymentManagedT.id),
  canaryId: uuid("canary_id").references(() => deploymentCanaryT.id),

  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  uniqueIndex("deployment_public_specifier_organization_id_idx")
    .on(table.publicSpecifier, table.organizationId)
    .where(sql`${table.deletedAt} IS NULL`),
  uniqueIndex("deployment_legacy_id_idx").on(table.legacyId),
  uniqueIndex("deployment_managed_id_idx").on(table.managedId),
  uniqueIndex("deployment_canary_id_idx").on(table.canaryId),
  // Every type adds its column to num_nonnulls and its case, so exactly the row of the named type is set.
  check("deployment_type_row_check", sql`num_nonnulls(${table.legacyId}, ${table.managedId}, ${table.canaryId}) = 1 AND CASE ${table.type}
    WHEN 'legacy' THEN ${table.legacyId} IS NOT NULL
    WHEN 'managed' THEN ${table.managedId} IS NOT NULL
    WHEN 'canary' THEN ${table.canaryId} IS NOT NULL
    ELSE false
  END`),
]);
export type Deployment = InferSelectModel<typeof deploymentT>;

/** A deployment of the original kind: a model scheduled onto our own nodes, optionally as a canary between two models. */
export const deploymentLegacyT = pgTable("deployment_legacy", {
  id: uuid().primaryKey().defaultRandom(),
  /** Canonical model identifier. */
  specifier: text().notNull(),
  /** Canonical identifier for the canary (early) model in a canary deployment. */
  earlySpecifier: text("early_specifier"),
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
  settings: jsonb().notNull().$type<DeploymentSettings>().default({ version: 1 }),

  createdAt,
  updatedAt,
});
export type DeploymentLegacy = InferSelectModel<typeof deploymentLegacyT>;

/** One model scheduled onto our own nodes. A canary's members are rows of this table without an entry of their own. */
export const deploymentManagedT = pgTable("deployment_managed", {
  id: uuid().primaryKey().defaultRandom(),
  /** Canonical model identifier. */
  specifier: text().notNull(),
  /** Ignored while the row is a canary member, whose replicas come from the canary's budget. */
  replicas: integer().notNull().default(1),
  /** User-specified KV-cache in GB. Null means use the model's default minKvCache. */
  kvCacheSize: real("kv_cache_size"),
  /** User-specified preferred inference driver. Null means auto (system default). */
  preferredDriver: inferenceDriverEnum("preferred_driver"),
  settings: jsonb().notNull().$type<DeploymentSettings>().default({ version: 1 }),

  createdAt,
  updatedAt,
});
export type DeploymentManaged = InferSelectModel<typeof deploymentManagedT>;

/** A rollout that moves traffic from one managed row to another. */
export const deploymentCanaryT = pgTable("deployment_canary", {
  id: uuid().primaryKey().defaultRandom(),
  /** The member traffic moves away from. */
  fromId: uuid("from_id").notNull().references(() => deploymentManagedT.id),
  /** The member traffic moves to. */
  toId: uuid("to_id").notNull().references(() => deploymentManagedT.id),
  /** Replicas the two members share, split between them by progress. */
  replicas: integer().notNull().default(1),
  /** Share of traffic, in percent, that goes to the `to` member. */
  progress: integer().notNull().default(0),
  /** How progress moves. The dashboard writes `progress` from it, which is all the gateway reads. */
  advance: jsonb().notNull().$type<RolloutAdvance>().default({ type: "manual", version: 1 }),

  createdAt,
  updatedAt,
}, table => [
  uniqueIndex("deployment_canary_from_id_idx").on(table.fromId),
  uniqueIndex("deployment_canary_to_id_idx").on(table.toId),
  check("deployment_canary_members_check", sql`${table.fromId} <> ${table.toId}`),
]);
export type DeploymentCanary = InferSelectModel<typeof deploymentCanaryT>;

/**
 * Represents a known ai node, incl. its reachable ip in the system, estimated capacity and links to models deployed on it
 */
export const aiNodeT = pgTable("ai_node", {
  id: uuid().primaryKey().defaultRandom(),
  host: text().notNull(),
  port: integer().notNull(),
  /** estimated capacity available on the node, as GB of estimated usable model capacity */
  estCapacity: real("est_capacity").notNull(),
  /** RAM the node can give installations, in decimal GB. Null when the node does not report it, which leaves host memory unlimited. */
  hostMemoryGb: real("host_memory_gb"),
  available: boolean().notNull().default(true),
  /** Number of GPUs detected on this node. 0 means CPU-only. */
  gpuCount: integer("gpu_count").notNull().default(0),
  /** Maps driver name to its detected version string, e.g. {"vllm": "0.19.1", "ollama": "0.6.3"} */
  driverVersions: jsonb("driver_versions").$type<Record<string, string>>().notNull().default({}),
  /** Maps driver name to detected optional features, e.g. {"vllm": ["audio", "vllm-omni"]} */
  driverFeatures: jsonb("driver_features").$type<Record<string, string[]>>().notNull().default({}),
  /** Detected GPUs with vendor, name, and VRAM. Empty = unknown/CPU-only. */
  gpus: jsonb().$type<GpuInfo[]>().notNull().default([]),
  /** RDMA-capable ports as the daemon last reported them. Empty when the node has none. */
  interconnect: jsonb().$type<InterconnectPort[]>().notNull().default([]),
  /** Random token generated on daemon startup, used by the gateway to authenticate requests to this node. */
  authToken: text("auth_token"),
  /** Ed25519 public key pinned on first registration. Null means not yet pinned, which adopts the next key seen. */
  publicKey: text("public_key"),
  /** Whether this node serves over TLS. Set by the daemon based on its config. */
  tls: boolean().notNull().default(false),
  /** Operator-assigned display name for this node (from MACHINE_NAME env var, falls back to hostname). */
  machineName: text("machine_name"),

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
  /** The legacy row this installation serves. Exactly one of `legacyId` and `managedId` is set. */
  legacyId: uuid("legacy_id").references(() => deploymentLegacyT.id, { onDelete: "cascade" }),
  /** The managed row this installation serves. */
  managedId: uuid("managed_id").references(() => deploymentManagedT.id, { onDelete: "cascade" }),
  /** Canonical model identifier. */
  specifier: text().notNull(),
  /** GPU memory in GB the installation occupies on its node, summed over all its cards */
  estCapacity: real("est_capacity").notNull(),
  /** KV-cache allocation in GB, used by the daemon for vLLM's --kv-cache-memory-bytes */
  kvCacheCapacity: real("kv_cache_capacity").notNull().default(0),
  /** Host RAM in GB the installation is charged on its node. */
  hostCapacity: real("host_capacity"),
  /** Sequences the engine runs at once. Null where the scheduler does not decide it: Ollama, and entries of the deprecated format. */
  maxNumSeqs: integer("max_num_seqs"),
  /** @deprecated Internal to the daemon. The gateway routes through the daemon proxy and does not use this field. */
  port: integer().notNull(),
  driver: inferenceDriverEnum().notNull(),
  settings: jsonb().notNull().$type<DeploymentSettings>().default({ version: 1 }),
  /** Empty means unpinned, which the daemon runs on the node's first card. */
  gpuIds: jsonb("gpu_ids").$type<string[]>().notNull().default([]),
  /** This node's member of an installation served across several nodes. Null for one served on this node alone. */
  group: jsonb().$type<InstallationGroup>(),

  deletedAt,
  createdAt,
  updatedAt,
}, table => [
  index("model_installation_node_id_idx").on(table.nodeId),
  index("model_installation_legacy_id_idx").on(table.legacyId),
  index("model_installation_managed_id_idx").on(table.managedId),
  index("model_installation_specifier_idx").on(table.specifier),
  index("model_installation_deleted_at_idx").on(table.deletedAt),
  check("model_installation_owner_check", sql`num_nonnulls(${table.legacyId}, ${table.managedId}) = 1`),
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
  /** How far a member of a group is toward starting with the others. Null for an installation served on one node alone. */
  groupStage: groupStageEnum("group_stage"),
  /** The attempt of its group the stage belongs to. */
  groupGeneration: integer("group_generation"),

  createdAt,
  updatedAt,
});
