import { toFlatSchema } from "common-env";
import { tetherConfig } from "./config-schema";

// The env-keyed projection of the declaration, kept for the CLI, which introspects a schema at
// runtime to build its editor. The tether itself reads `config`.
export const tetherEnvSchema = toFlatSchema(tetherConfig);
