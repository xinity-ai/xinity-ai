import { toFlatSchema } from "common-env";
import { infoserverConfig } from "./config-schema";

// The env-keyed projection of the declaration, kept for the CLI, which introspects a schema at
// runtime to build its editor. The infoserver itself reads `config`.
export const infoserverEnvSchema = toFlatSchema(infoserverConfig);
