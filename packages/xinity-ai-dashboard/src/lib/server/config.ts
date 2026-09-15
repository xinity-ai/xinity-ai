import { createDynamicConfig } from "common-env";
import { dashboardConfig, type DashboardConfig } from "./config-schema";

export const configStore = createDynamicConfig({ declaration: dashboardConfig });

export const config: DashboardConfig = configStore.value;
