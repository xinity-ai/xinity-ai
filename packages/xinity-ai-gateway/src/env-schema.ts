import { toFlatSchema } from "common-env";
import { gatewayConfig } from "./config-schema";

// The env-keyed projection of the declaration, kept for the CLI, which introspects a schema at
// runtime to build its editor. The gateway itself reads `config`.
export const gatewayEnvSchema = toFlatSchema(gatewayConfig);
