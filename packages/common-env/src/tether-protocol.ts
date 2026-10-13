import { z } from "zod";
import { deploymentSettingsSchema } from "./deployment-settings";

const driverEnum = z.enum(["ollama", "vllm"]);

const lifecycleStateEnum = z.enum(["downloading", "installing", "ready", "failed"]);

export const gpuSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  // 0 when VRAM is not separately addressable (e.g. unified memory)
  vramMb: z.number(),
  // The vendor tool's own device index, not the position in a mixed-vendor list
  index: z.number().optional(),
  uuid: z.string().optional(),
  pciBusId: z.string().optional(),
});
export type GpuInfo = z.infer<typeof gpuSchema>;

export function gpuId(gpu: Pick<GpuInfo, "uuid" | "pciBusId">): string | undefined {
  return gpu.uuid ?? gpu.pciBusId;
}

const interconnectPathSchema = z.object({
  interface: z.string(),
  // Not z.mac(): it accepts only 6-byte Ethernet addresses, and an InfiniBand port's is 20 bytes.
  // One such port would get the whole registration refused.
  mac: z.string(),
  carrier: z.boolean(),
  mtu: z.number(),
  speedMbps: z.number().nullable(),
  linkLayer: z.string().nullable(),
  ipv4: z.array(z.cidrv4()),
  // The subset of the port's IPv4 addresses that RDMA can use
  roceV2Ipv4: z.array(z.ipv4()),
  // How often the path went from having an IPv4 address to having none since the daemon started
  addressLosses: z.number().int().nonnegative(),
});
export type InterconnectPath = z.infer<typeof interconnectPathSchema>;

// One physical port of an RDMA-capable network card, which can appear as several PCIe paths
export const interconnectPortSchema = z.object({
  networkCard: z.string(),
  port: z.string(),
  paths: z.array(interconnectPathSchema),
  // MACs of other nodes seen on the port, plain strings for the same reason as a path's mac
  neighbours: z.array(z.string()),
});
export type InterconnectPort = z.infer<typeof interconnectPortSchema>;

// Outbound: tether -> daemon (SSE)

export const desiredInstallationSchema = z.object({
  installationId: z.uuid(),
  specifier: z.string(),
  driver: driverEnum,
  estCapacity: z.number(),
  kvCacheCapacity: z.number(),
  port: z.number(),
  settings: deploymentSettingsSchema,
  gpuIds: z.array(z.string()),
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
  interconnect: z.array(interconnectPortSchema),
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

export const interconnectReportSchema = z.object({
  nodeId: z.uuid(),
  interconnect: z.array(interconnectPortSchema),
  signature: z.string(),
});
export type InterconnectReport = z.infer<typeof interconnectReportSchema>;
export type UnsignedInterconnectReport = Omit<InterconnectReport, "signature">;

// What the daemon signs with its node key. Positional and sorted rather than derived from the
// object, because the two ends must produce identical bytes from the same payload. The request's
// Authorization header is signed along with it, so a captured body cannot be sent again on a
// request of its own.

function sortedPairs(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
}

function canonicalInterconnect(ports: InterconnectPort[]): unknown[] {
  return ports.map((p) => [
    p.networkCard,
    p.port,
    p.paths.map((path) => [
      path.interface, path.mac, path.carrier, path.mtu, path.speedMbps, path.linkLayer, path.ipv4, path.roceV2Ipv4, path.addressLosses,
    ]),
    p.neighbours,
  ]);
}

export function canonicalRegistration(reg: UnsignedNodeRegistration, requestAuthorization: string): string {
  return JSON.stringify([
    reg.nodeId,
    reg.host,
    reg.port,
    reg.gpuCount,
    reg.gpus.map((g) => [g.vendor, g.name, g.vramMb, g.index ?? null, g.uuid ?? null, g.pciBusId ?? null]),
    canonicalInterconnect(reg.interconnect),
    sortedPairs(reg.driverVersions),
    sortedPairs(reg.driverFeatures),
    reg.tls,
    reg.estCapacity,
    reg.machineName ?? null,
    reg.authToken,
    reg.protocolFingerprint,
    reg.publicKey,
    requestAuthorization,
  ]);
}

export function canonicalStateReport(report: UnsignedInstallationStateReport, requestAuthorization: string): string {
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
    requestAuthorization,
  ]);
}

export function canonicalInterconnectReport(report: UnsignedInterconnectReport, requestAuthorization: string): string {
  return JSON.stringify([report.nodeId, canonicalInterconnect(report.interconnect), requestAuthorization]);
}

export const tetherRefusalReasonSchema = z.enum([
  "unauthorized",
  "unauthorized_stale",
  "unauthorized_replayed",
  "invalid_payload",
  "protocol_mismatch",
  "registration_failed",
  "identity_mismatch",
  "invalid_signature",
  "installation_not_owned",
  "method_not_allowed",
]);
export type TetherRefusalReason = z.infer<typeof tetherRefusalReasonSchema>;

export type TetherRefusal = { error: string; reason: TetherRefusalReason };

export const tetherConnectionSchema = z.object({
  state: z.enum(["connecting", "connected", "refused", "unreachable"]),
  reason: tetherRefusalReasonSchema.optional(),
  since: z.iso.datetime(),
});
export type TetherConnection = z.infer<typeof tetherConnectionSchema>;

/** Signed by the caller and verified by the tether, so both ends must name them identically. */
export const STREAM_PATH = "/api/v1/stream";
export const STATUS_PATH = "/api/v1/status";
export const INTERCONNECT_PATH = "/api/v1/interconnect";

export const KEEPALIVE_INTERVAL_HEADER = "X-Keepalive-Interval-Ms";

// Bump whenever signing changes
const SIGNED_FORM_VERSION = 3;

let cachedFingerprint: string | null = null;

export function protocolFingerprint(): string {
  if (cachedFingerprint) {
    return cachedFingerprint;
  }
  const manifest = JSON.stringify([
    z.toJSONSchema(desiredStateSchema),
    z.toJSONSchema(nodeRegistrationSchema),
    z.toJSONSchema(installationStateReportSchema),
    z.toJSONSchema(interconnectReportSchema),
    SIGNED_FORM_VERSION,
  ]);
  cachedFingerprint = new Bun.CryptoHasher("sha256")
    .update(manifest)
    .digest("hex")
    .slice(0, 16);
  return cachedFingerprint;
}
