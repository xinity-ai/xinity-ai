import { createDynamicConfig } from "common-env";
import { daemonConfig, type DaemonConfig } from "./config-schema";

export const configStore = createDynamicConfig({ declaration: daemonConfig });

export const config: DaemonConfig = configStore.value;
