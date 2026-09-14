import { configFromProcessEnv } from "common-env";
import { tetherConfig, type TetherConfig } from "./config-schema";

export const config: TetherConfig = configFromProcessEnv(tetherConfig);
