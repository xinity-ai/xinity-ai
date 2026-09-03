import { resolveConfig } from "common-env";
import { tetherConfig, type TetherConfig } from "./config-schema";

export const config: TetherConfig = resolveConfig<TetherConfig>(tetherConfig, {
  env: process.env,
}).value;
