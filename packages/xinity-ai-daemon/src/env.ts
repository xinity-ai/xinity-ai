import { parseEnv } from "common-env";
import { daemonEnvSchema } from "./env-schema";

export const env = parseEnv(daemonEnvSchema);
