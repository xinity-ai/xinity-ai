import { toFlatSchema } from "common-env";
import { dashboardConfig } from "./config-schema";

// The env-keyed projection of the declaration, kept for the CLI, which introspects a schema at
// runtime to build its editor. The dashboard itself reads `config`.
export const dashboardEnvSchema = toFlatSchema(dashboardConfig);
