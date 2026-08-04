import { z } from "zod";
import { expert } from "common-env";
import { logEnvSchema } from "common-log";

export const infoserverEnvSchema = z.object({
  MODEL_INFO_DIR: z.string().describe("Directory of model YAML files (*.yaml, *.yml) in the current format"),
  MODEL_LEGACY_DIR: z.string().optional().describe("Directory of model YAML files in the deprecated v1 format, served only on the v1 endpoints. Removed before 1.0.0, so migrate these entries to MODEL_INFO_DIR. Leave unset to serve the v1 endpoints as an empty catalog"),
  PORT: z.coerce.number().default(8090).describe("Listen port"),
  REFRESH_INTERVAL_MS: z.coerce.number().default(5 * 60_000).describe("How often to re-read model file and re-fetch includes (ms)").meta(expert()),
  MAX_INCLUDE_DEPTH: z.coerce.number().default(10).describe("Maximum recursion depth when resolving include URLs").meta(expert()),
  RATE_LIMIT_ENABLED: z.stringbool().default(true).describe("Apply per-client request ceilings. Disable only on a trusted network").meta(expert()),
  RATE_LIMIT_EXPORT_PER_MINUTE: z.coerce.number().int().min(1).default(6).describe("Full-catalog export requests allowed per client per minute, spendable all at once. The catalog only changes once per REFRESH_INTERVAL_MS, so polling faster than this gains nothing").meta(expert()),
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).default(600).describe("Programmatic API requests allowed per client per minute, spendable all at once").meta(expert()),
  HTTP_IP_HEADER: z.string().optional().describe("Forwarding header the client address is read from (e.g. X-Forwarded-For). Required behind a reverse proxy, since requests otherwise all appear to come from the proxy. Leave unset when the server is reachable directly").meta(expert()),
  HTTP_XFF_DEPTH: z.coerce.number().int().min(1).default(1).describe("Number of proxies in front of this server. The address is taken that many entries from the right of HTTP_IP_HEADER, since anything further left is client-supplied and forgeable").meta(expert()),
}).extend(logEnvSchema.shape);
