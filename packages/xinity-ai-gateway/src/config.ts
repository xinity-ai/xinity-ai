import { resolveConfig } from "common-env";
import { gatewayConfig, type GatewayConfig } from "./config-schema";

export const config: GatewayConfig = resolveConfig<GatewayConfig>(gatewayConfig, {
  env: process.env,
}).value;
