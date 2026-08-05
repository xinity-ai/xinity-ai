import { parseEnv } from "common-env";
import { tetherEnvSchema } from "./env-schema";

export const env = parseEnv(tetherEnvSchema);
