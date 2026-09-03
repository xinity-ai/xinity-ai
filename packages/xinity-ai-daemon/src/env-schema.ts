import { toFlatSchema } from "common-env";
import { daemonConfig } from "./config-schema";

// The env-keyed projection of the declaration, kept for the CLI, which introspects a schema at
// runtime to build its editor. The daemon itself reads `config`.
export const daemonEnvSchema = toFlatSchema(daemonConfig);
