import { createDynamicConfig } from "common-env";
import { gatewayConfig, type GatewayConfig } from "./config-schema";

export const configStore = createDynamicConfig({ declaration: gatewayConfig });

export const config: GatewayConfig = configStore.value;
