import { z } from "zod";

const driverEnum = z.enum(["ollama", "vllm"]);

const lifecycleStateEnum = z.enum(["downloading", "installing", "ready", "failed"]);

const gpuSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramMb: z.number(),
});

const deploymentSettingsSchema = z.object({
  version: z.literal(1),
  maxAudioInputDurationS: z.number().optional(),
  maxAudioInputFileSizeMB: z.number().optional(),
});

// Outbound: tether -> daemon (SSE)

export const desiredInstallationSchema = z.object({
  installationId: z.string().uuid(),
  specifier: z.string(),
  driver: driverEnum,
  estCapacity: z.number(),
  kvCacheCapacity: z.number(),
  port: z.number(),
  settings: deploymentSettingsSchema,
});
export type DesiredInstallation = z.infer<typeof desiredInstallationSchema>;

export const desiredStateSchema = z.object({
  nodeId: z.string().uuid(),
  installations: z.array(desiredInstallationSchema),
});
export type DesiredState = z.infer<typeof desiredStateSchema>;

// Inbound: daemon -> tether (POST /api/v1/register)

export const nodeRegistrationSchema = z.object({
  nodeId: z.string().uuid(),
  host: z.string(),
  port: z.number(),
  gpuCount: z.number(),
  gpus: z.array(gpuSchema),
  driverVersions: z.record(z.string(), z.string()),
  driverFeatures: z.record(z.string(), z.array(z.string())),
  tls: z.boolean(),
  estCapacity: z.number(),
  machineName: z.string().optional(),
  authToken: z.string(),
  protocolFingerprint: z.string(),
});
export type NodeRegistration = z.infer<typeof nodeRegistrationSchema>;

// Inbound: daemon -> tether (POST /api/v1/status)

export const installationStatePayloadSchema = z.object({
  installationId: z.string().uuid(),
  lifecycleState: lifecycleStateEnum,
  progress: z.number().nullable().optional(),
  statusMessage: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  failureLogs: z.string().nullable().optional(),
});
export type InstallationStatePayload = z.infer<typeof installationStatePayloadSchema>;

export const installationStateReportSchema = z.object({
  nodeId: z.string().uuid(),
  states: z.array(installationStatePayloadSchema),
});
export type InstallationStateReport = z.infer<typeof installationStateReportSchema>;

let cachedFingerprint: string | null = null;

export function protocolFingerprint(): string {
  if (cachedFingerprint) {
    return cachedFingerprint;
  }
  const manifest = JSON.stringify([
    z.toJSONSchema(desiredStateSchema),
    z.toJSONSchema(nodeRegistrationSchema),
    z.toJSONSchema(installationStateReportSchema),
  ]);
  cachedFingerprint = new Bun.CryptoHasher("sha256")
    .update(manifest)
    .digest("hex")
    .slice(0, 16);
  return cachedFingerprint;
}
