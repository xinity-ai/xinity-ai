import { parseEnv } from "common-env";
import { conductorEnvSchema } from "./env-schema.ts";

export const env = parseEnv(conductorEnvSchema);
