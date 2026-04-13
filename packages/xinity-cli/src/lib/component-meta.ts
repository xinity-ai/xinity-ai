/**
 * Static metadata for Xinity service components.
 *
 * Types, constants, env schema registry, and path conventions used across
 * the CLI. Zero runtime dependencies, intentionally kept side-effect-free
 * so any module can import without pulling in install/service logic.
 */
import { z } from "zod";

import { gatewayEnvSchema } from "xinity-ai-gateway/src/env-schema.ts";
import { daemonEnvSchema } from "xinity-ai-daemon/src/env-schema.ts";
import { dashboardEnvSchema } from "xinity-ai-dashboard/src/lib/server/env-schema.ts";
import { infoserverEnvSchema } from "xinity-infoserver/env-schema.ts";

export type { Release } from "./github.ts";

export type Component = "gateway" | "dashboard" | "daemon" | "infoserver";

export const ENV_SCHEMAS: Record<Component, z.ZodObject<any>> = {
  gateway: gatewayEnvSchema,
  dashboard: dashboardEnvSchema,
  daemon: daemonEnvSchema,
  infoserver: infoserverEnvSchema,
};

export const ENV_DIR = "/etc/xinity-ai";
export const SECRETS_DIR = "/etc/xinity-ai/secrets";
export const BIN_DIR = "/opt/xinity/bin";
/** Legacy install path used by the tarball-based installer. Kept for migration/uninstall cleanup. */
export const DASHBOARD_DIR = "/opt/xinity/dashboard";
export const UNIT_DIR = "/etc/systemd/system";

/** Map component name to its compiled binary filename. */
export function binaryBaseName(component: Component): string {
  if (component === "infoserver") return "xinity-infoserver";
  return `xinity-ai-${component}`;
}

export interface InstallResult {
  success: boolean;
  version: string;
  errors: string[];
}

export interface RemoveResult {
  success: boolean;
  errors: string[];
}

/**
 * Sensible auto-defaults derived from the systemd unit configuration.
 * These are used as lowest-priority defaults during env prompting;
 * existing config file values always take precedence.
 */
export function getAutoDefaults(component: Component): Record<string, string> {
  // systemd StateDirectory=xinity-ai-{component} → /var/lib/xinity-ai-{component}
  const stateDir = `/var/lib/xinity-ai-${component}`;
  const common: Record<string, string> = {
    INFOSERVER_URL: "https://sysinfo.xinity.ai",
  };

  switch (component) {
    case "daemon":
      return { ...common, STATE_DIR: stateDir };
    case "dashboard":
      return { ...common, NODE_ENV: "production" };
    case "infoserver":
      return {};
    default:
      return common;
  }
}
