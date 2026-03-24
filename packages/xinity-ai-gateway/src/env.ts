import { parseEnv } from "common-env";
import { gatewayEnvSchema } from "./env-schema.ts";

export const env = parseEnv(gatewayEnvSchema);
