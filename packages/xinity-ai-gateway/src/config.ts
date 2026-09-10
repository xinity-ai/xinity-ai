import { configFromProcessEnv } from "common-env";
import { gatewayConfig, type GatewayConfig } from "./config-schema";

export const config: GatewayConfig = configFromProcessEnv(gatewayConfig);
