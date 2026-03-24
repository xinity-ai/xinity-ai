import { parseEnv } from "common-env";
import { daemonEnvSchema } from "./env-schema.ts";

export const env = parseEnv(daemonEnvSchema);
