import { configFromProcessEnv } from "common-env";
import { daemonConfig, type DaemonConfig } from "./config-schema";

export const config: DaemonConfig = configFromProcessEnv(daemonConfig);
