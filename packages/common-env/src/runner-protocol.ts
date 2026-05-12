import { z } from "zod";

/** Static information a runner sends about itself when it first connects. Carried in the StatusReport `registration` field. */
export const NodeRegistration = z.object({
  host: z.string().describe("Reachable host or IP for this runner"),
  port: z.number().int().nonnegative(),
  estCapacity: z.number().describe("Estimated GPU capacity in GB"),
  drivers: z.array(z.string()).describe("Inference drivers this runner supports"),
  driverVersions: z.record(z.string(), z.string()).describe("Driver name → version string"),
  gpuCount: z.number().int().nonnegative(),
  gpus: z.array(z.object({
    vendor: z.string(),
    name: z.string(),
    vramMb: z.number().int().nonnegative(),
  })),
  tls: z.boolean(),
});
export type NodeRegistration = z.infer<typeof NodeRegistration>;

/** Per-installation lifecycle update. */
export const InstallationStatePayload = z.object({
  installationId: z.uuid().describe("Conductor-issued installation id (echoed from the desired state)"),
  lifecycleState: z.enum(["downloading", "installing", "ready", "failed"]),
  progress: z.number().nullable().optional(),
  statusMessage: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  failureLogs: z.string().nullable().optional(),
});
export type InstallationStatePayload = z.infer<typeof InstallationStatePayload>;

/** Batched status report a runner sends to the conductor. Either field may be absent. */
export const StatusReport = z.object({
  /** The runner's own node id (`aiNodeT.id`). Sent by runner during dual-write; goes away when the conductor owns identity end-to-end. */
  nodeId: z.uuid(),
  registration: NodeRegistration.optional(),
  installations: z.array(InstallationStatePayload).default([]),
});
export type StatusReport = z.infer<typeof StatusReport>;

/** A single installation the runner should have, as decided by the conductor's orchestration. */
export const DesiredInstallation = z.object({
  installationId: z.uuid(),
  specifier: z.string().nullable(),
  /** Legacy provider-string fallback for installations not yet migrated to canonical specifier. */
  model: z.string(),
  driver: z.enum(["ollama", "vllm"]),
  estCapacity: z.number(),
  kvCacheCapacity: z.number(),
  port: z.number().int().nonnegative(),
});
export type DesiredInstallation = z.infer<typeof DesiredInstallation>;

/** Full desired state for a runner. The conductor sends this on connect and on every relevant change. */
export const DesiredState = z.object({
  nodeId: z.uuid(),
  installations: z.array(DesiredInstallation),
});
export type DesiredState = z.infer<typeof DesiredState>;
