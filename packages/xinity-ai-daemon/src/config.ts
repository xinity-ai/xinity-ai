import { resolveConfig } from "common-env";
import { daemonConfig, type DaemonConfig } from "./config-schema";

export const config: DaemonConfig = resolveConfig<DaemonConfig>(daemonConfig, {
  env: process.env,
}).value;
