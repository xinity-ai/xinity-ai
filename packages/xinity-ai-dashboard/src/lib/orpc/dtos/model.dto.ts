/**
 * DTO schema for model deployments.
 */
import { z } from "zod";
import { OPTIMIZATION_GOALS } from "common-env/deployment-settings";
import { rolloutAdvanceSchema } from "common-env/rollout-advance";
import { CommonDto, commonInputFilter } from "./common.dto";

export const DeploymentSettingsDto = z.object({
  version: z.literal(1),
  maxAudioInputDurationS: z.number().int().min(1).max(24 * 60 * 60).optional(),
  maxAudioInputFileSizeMB: z.number().int().min(1).optional(),
  optimizeFor: z.enum(OPTIMIZATION_GOALS).optional(),
});

const ReplicaPhaseDto = z.enum(["ready", "downloading", "installing", "failed", "scheduling"]);

export const ReplicaStatusDto = z.object({
  phase: ReplicaPhaseDto,
  node: z.string().nullable(),
  error: z.string().nullable(),
  /** Each machine of a replica served across several, by rank. */
  members: z.array(z.object({
    node: z.string(),
    phase: ReplicaPhaseDto,
    error: z.string().nullable(),
    cards: z.number().describe("Cards the member uses on its machine"),
    gpuGb: z.number().describe("GPU memory in GB the member occupies on its machine, over all its cards"),
    hostGb: z.number().describe("Host memory in GB the member occupies on its machine"),
  })).optional(),
  couplingIssues: z.array(z.object({ text: z.string(), docsUrl: z.string() }))
    .describe("What is wrong with the coupling the replica runs across, each with a link to how to fix it")
    .optional(),
});
export type ReplicaStatus = z.infer<typeof ReplicaStatusDto>;

export const DeploymentStatusDto = z.object({
  phase: z.enum(["ready", "downloading", "installing", "failed", "scheduling", "not_in_catalog", "partial"]),
  progress: z.number().nullable(),
  error: z.string().nullable().optional(),
  failureLogs: z.string().nullable().optional(),
  replicas: ReplicaStatusDto.array().optional(),
});
export type StatusPhase = z.infer<typeof DeploymentStatusDto>["phase"];

export const ReplicasDto = z.number().int().min(1);
export const MIN_CANARY_REPLICAS = 2;
export const CanaryReplicasDto = z.number().int().min(MIN_CANARY_REPLICAS);
export const ProgressDto = z.number().int().min(0).max(100);
export const KvCacheSizeDto = z.number().positive();

const PublicSpecifierDto = z.string().trim()
  .refine(s => !s.endsWith("-deep-research"), {
    message: "Deployment names cannot end with '-deep-research' (reserved suffix)",
  });

export const DeploymentBaseDto = CommonDto.extend({
  name: z.string().trim(),
  description: z.string().nullish(),
  enabled: z.boolean(),
  publicSpecifier: PublicSpecifierDto,
  status: DeploymentStatusDto.optional(),
});

export const LegacyDeploymentDto = z.object({
  /** Canonical model identifier. */
  specifier: z.string().trim(),
  /** In a canary rollout, the model traffic moves away from. `specifier` is the canary and `progress` its share. */
  earlySpecifier: z.string().trim().nullish(),
  replicas: z.number().default(1),
  canaryProgressUntil: z.date().nullish(),
  canaryProgressFrom: z.date().nullish(),
  canaryProgressWithFeedback: z.boolean().default(false),
  progress: z.number().default(100),
  kvCacheSize: z.number().nullish(),
  earlyKvCacheSize: z.number().nullish(),
  preferredDriver: z.enum(["ollama", "vllm"]).nullish(),
  settings: DeploymentSettingsDto.optional(),
  /** Set while the model is only served by the deprecated catalog. Removed before 1.0.0. */
  deprecatedModel: z.boolean().optional(),
});
export type LegacyDeploymentOutput = z.infer<typeof LegacyDeploymentDto>;

export const ManagedDeploymentDto = z.object({
  /** Canonical model identifier. */
  specifier: z.string().trim(),
  replicas: z.number(),
  kvCacheSize: z.number().nullish(),
  preferredDriver: z.enum(["ollama", "vllm"]).nullish(),
  settings: DeploymentSettingsDto.optional(),
});

const CanaryMemberDto = ManagedDeploymentDto.omit({ replicas: true });

export const CanaryDeploymentDto = z.object({
  replicas: z.number().describe("Replicas the two members share, split between them by progress, at least 2"),
  progress: z.number().describe("Share of traffic, in percent, that goes to `to`"),
  advance: rolloutAdvanceSchema.describe("How progress moves"),
  from: CanaryMemberDto.describe("The model traffic moves away from"),
  to: CanaryMemberDto.describe("The model traffic moves to"),
});

export const DeploymentDto = z.discriminatedUnion("type", [
  DeploymentBaseDto.extend({ type: z.literal("legacy"), legacy: LegacyDeploymentDto }),
  DeploymentBaseDto.extend({ type: z.literal("managed"), managed: ManagedDeploymentDto }),
  DeploymentBaseDto.extend({ type: z.literal("canary"), canary: CanaryDeploymentDto }),
]);
export type DeploymentOutput = z.infer<typeof DeploymentDto>;

// Stored rows are read back through DeploymentDto, so the stricter rules apply to what is written only.
export const DeploymentBaseInputDto = DeploymentBaseDto.omit({ id: true, status: true, ...commonInputFilter }).extend({
  publicSpecifier: PublicSpecifierDto
    .pipe(z.string().min(5).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
      message: "Use letters, digits and . _ -, starting with a letter or digit",
    })),
});

export const LegacyDeploymentInputDto = LegacyDeploymentDto.omit({ deprecatedModel: true }).extend({
  replicas: ReplicasDto.default(1),
  progress: ProgressDto.default(100),
  kvCacheSize: KvCacheSizeDto.nullish(),
  earlyKvCacheSize: KvCacheSizeDto.nullish(),
});
export type LegacyDeploymentInput = z.infer<typeof LegacyDeploymentInputDto>;

export const ManagedDeploymentInputDto = ManagedDeploymentDto.extend({
  replicas: ReplicasDto.default(1),
  kvCacheSize: KvCacheSizeDto.nullish(),
});
export type ManagedDeploymentInput = z.infer<typeof ManagedDeploymentInputDto>;

export const CanaryMemberInputDto = ManagedDeploymentInputDto.omit({ replicas: true });
export type CanaryMemberInput = z.infer<typeof CanaryMemberInputDto>;

export const DeploymentInputDto = z.discriminatedUnion("type", [
  DeploymentBaseInputDto.extend({ type: z.literal("legacy"), legacy: LegacyDeploymentInputDto }),
  DeploymentBaseInputDto.extend({ type: z.literal("managed"), managed: ManagedDeploymentInputDto }),
]);

// Zod still applies a default under .optional(), so .partial() alone would reset omitted fields.
export const LegacyDeploymentPatchDto = LegacyDeploymentInputDto
  .extend({
    replicas: ReplicasDto,
    canaryProgressWithFeedback: z.boolean(),
    progress: ProgressDto,
  })
  .partial();

export const ManagedDeploymentPatchDto = ManagedDeploymentInputDto.extend({ replicas: ReplicasDto }).partial();

const CanaryMemberPatchDto = CanaryMemberInputDto.partial();

export const RolloutAdvanceInputDto = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("time"),
    until: z.coerce.date().describe("When progress reaches 100, moving there evenly from the current progress and time"),
  }),
]);
export type RolloutAdvanceInput = z.infer<typeof RolloutAdvanceInputDto>;

export const CANARY_MEMBERS = ["from", "to"] as const;

/** What a deployment becomes, keyed by its new type. */
export const RolloutDto = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid(),
    type: z.literal("canary"),
    canary: z.object({
      to: CanaryMemberInputDto.describe("The model traffic moves to. Driver and settings default to those of the current model"),
      progress: ProgressDto.default(0).describe("Share of traffic, in percent, that goes to the new model at first"),
      advance: RolloutAdvanceInputDto.default({ type: "manual" }),
    }),
  }),
  z.object({
    id: z.uuid(),
    type: z.literal("managed"),
    managed: z.union([
      z.object({
        keep: z.enum(CANARY_MEMBERS).describe("The model that keeps serving with all of the canary's replicas: `to` promotes, `from` rolls back"),
      }).describe("Ends a canary on one of its two models"),
      z.object({
        to: CanaryMemberInputDto.describe("The model that replaces the current one. Driver and settings default to those of the current model"),
      }).describe("Replaces a managed deployment's model at once. Serving pauses until the new model is installed"),
    ]),
  }),
]);
export type RolloutTarget = z.infer<typeof RolloutDto>;

export const CanaryDeploymentPatchDto = CanaryDeploymentDto.extend({
  replicas: CanaryReplicasDto,
  progress: ProgressDto.describe("Under a time-based advance, the rollout moves on to 100 from here"),
  advance: RolloutAdvanceInputDto,
  from: CanaryMemberPatchDto,
  to: CanaryMemberPatchDto,
}).partial();

/** Changes to the deployment's type-specific part go under the key of its type. */
export const DeploymentUpdateDto = DeploymentBaseInputDto.partial().extend({
  id: z.uuid(),
  legacy: LegacyDeploymentPatchDto.optional(),
  managed: ManagedDeploymentPatchDto.optional(),
  canary: CanaryDeploymentPatchDto.optional(),
});
export type DeploymentUpdate = z.infer<typeof DeploymentUpdateDto>;
