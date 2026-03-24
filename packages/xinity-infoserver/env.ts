import { parseEnv } from "common-env";
import { infoserverEnvSchema } from "./env-schema";

export const env = parseEnv(infoserverEnvSchema);
