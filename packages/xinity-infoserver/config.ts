import { configFromProcessEnv } from "common-env";
import { infoserverConfig, type InfoserverConfig } from "./config-schema";

export const config: InfoserverConfig = configFromProcessEnv(infoserverConfig);
