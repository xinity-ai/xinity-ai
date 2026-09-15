import { createDynamicConfig } from "common-env";
import { tetherConfig, type TetherConfig } from "./config-schema";

export const configStore = createDynamicConfig({ declaration: tetherConfig });

export const config: TetherConfig = configStore.value;
