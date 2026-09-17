import { z } from "zod";
import { deploymentSettingsSchema } from "./deployment-settings";

const driverEnum = z.enum(["ollama", "vllm"]);

const lifecycleStateEnum = z.enum(["downloading", "installing", "ready", "failed"]);

const gpuSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramMb: z.number(),
});

// Outbound: tether -> daemon (SSE)

export const desiredInstallationSchema = z.object({
  installationId: z.uuid(),
  specifier: z.string(),
  driver: driverEnum,
  estCapacity: z.number(),
  kvCacheCapacity: z.number(),
  port: z.number(),
  settings: deploymentSettingsSchema,
});
export type DesiredInstallation = z.infer<typeof desiredInstallationSchema>;

export const desiredStateSchema = z.object({
  nodeId: z.uuid(),
  installations: z.array(desiredInstallationSchema),
});
export type DesiredState = z.infer<typeof desiredStateSchema>;

// Inbound: daemon -> tether (POST /api/v1/register)

export const nodeRegistrationSchema = z.object({
  nodeId: z.uuid(),
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
  publicKey: z.string(),
  signature: z.string(),
});
export type NodeRegistration = z.infer<typeof nodeRegistrationSchema>;
export type UnsignedNodeRegistration = Omit<NodeRegistration, "signature">;

// Inbound: daemon -> tether (POST /api/v1/status)

export const installationStatePayloadSchema = z.object({
  installationId: z.uuid(),
  lifecycleState: lifecycleStateEnum,
  progress: z.number().nullable().optional(),
  statusMessage: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  failureLogs: z.string().nullable().optional(),
});
export type InstallationStatePayload = z.infer<typeof installationStatePayloadSchema>;

export const installationStateReportSchema = z.object({
  nodeId: z.uuid(),
  states: z.array(installationStatePayloadSchema),
  signature: z.string(),
});
export type InstallationStateReport = z.infer<typeof installationStateReportSchema>;
export type UnsignedInstallationStateReport = Omit<InstallationStateReport, "signature">;

// What the daemon signs with its node key. Positional and sorted rather than derived from the
// object, because the two ends must produce identical bytes from the same payload.

function sortedPairs(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
}

export function canonicalRegistration(reg: UnsignedNodeRegistration): string {
  return JSON.stringify([
    reg.nodeId,
    reg.host,
    reg.port,
    reg.gpuCount,
    reg.gpus.map((g) => [g.vendor, g.name, g.vramMb]),
    sortedPairs(reg.driverVersions),
    sortedPairs(reg.driverFeatures),
    reg.tls,
    reg.estCapacity,
    reg.machineName ?? null,
    reg.authToken,
    reg.protocolFingerprint,
    reg.publicKey,
  ]);
}

export function canonicalStateReport(report: UnsignedInstallationStateReport): string {
  return JSON.stringify([
    report.nodeId,
    report.states.map((s) => [
      s.installationId,
      s.lifecycleState,
      s.progress ?? null,
      s.statusMessage ?? null,
      s.errorMessage ?? null,
      s.failureLogs ?? null,
    ]),
  ]);
}

/** Signed by the caller and verified by the tether, so both ends must name them identically. */
export const STREAM_PATH = "/api/v1/stream";
export const STATUS_PATH = "/api/v1/status";

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
