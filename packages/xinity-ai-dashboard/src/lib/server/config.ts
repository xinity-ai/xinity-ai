import { resolveConfig } from "common-env";
import { dashboardConfig, type DashboardConfig } from "./config-schema";

export const config: DashboardConfig = resolveConfig<DashboardConfig>(dashboardConfig, {
  env: process.env,
}).value;
