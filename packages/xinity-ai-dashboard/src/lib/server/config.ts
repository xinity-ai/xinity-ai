import { configFromProcessEnv } from "common-env";
import { dashboardConfig, type DashboardConfig } from "./config-schema";

export const config: DashboardConfig = configFromProcessEnv(dashboardConfig);
