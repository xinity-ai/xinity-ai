import { resolveConfig } from "common-env";
import { infoserverConfig, type InfoserverConfig } from "./config-schema";

export const config: InfoserverConfig = resolveConfig<InfoserverConfig>(infoserverConfig, {
  env: process.env,
}).value;
