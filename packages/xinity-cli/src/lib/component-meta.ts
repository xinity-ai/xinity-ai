/**
 * Static metadata for Xinity service components.
 *
 * Types, constants, env schema registry, and path conventions used across
 * the CLI. Zero runtime dependencies, intentionally kept side-effect-free
 * so any module can import without pulling in install/service logic.
 */
import type { z } from "zod";

import { gatewayEnvSchema } from "xinity-ai-gateway/src/env-schema.ts";
import { daemonEnvSchema } from "xinity-ai-daemon/src/env-schema.ts";
import { dashboardEnvSchema } from "xinity-ai-dashboard/src/lib/server/env-schema.ts";
import { infoserverEnvSchema } from "xinity-infoserver/env-schema.ts";
import { tetherEnvSchema } from "xinity-tether/src/env-schema.ts";

export type { Release } from "./github.ts";

export type Component = "gateway" | "dashboard" | "daemon" | "infoserver" | "tether";

export const ENV_SCHEMAS: Record<Component, z.ZodObject<any>> = {
  gateway: gatewayEnvSchema,
  dashboard: dashboardEnvSchema,
  daemon: daemonEnvSchema,
  infoserver: infoserverEnvSchema,
  tether: tetherEnvSchema,
};

export const DERIVED_ENV_KEYS: Partial<Record<Component, readonly string[]>> = {
  dashboard: ["HTTP_OVERRIDE_ORIGIN"],
};

/** Listen ports assumed when PORT is not configured, taken from the env schemas. */
export const GATEWAY_DEFAULT_PORT = String(gatewayEnvSchema.shape.PORT.parse(undefined));
export const INFOSERVER_DEFAULT_PORT = String(infoserverEnvSchema.shape.PORT.parse(undefined));
export const TETHER_DEFAULT_PORT = String(tetherEnvSchema.shape.PORT.parse(undefined));

/** Where the daemon probes for ollama when OLLAMA_URL is left unset. */
export const DEFAULT_OLLAMA_URL = String(daemonEnvSchema.shape.OLLAMA_URL.parse(undefined));

export const ENV_DIR = "/etc/xinity-ai";
export const SECRETS_DIR = "/etc/xinity-ai/secrets";
export const BIN_DIR = "/opt/xinity/bin";
/** Legacy install path used by the tarball-based installer. Kept for migration/uninstall cleanup. */
export const DASHBOARD_DIR = "/opt/xinity/dashboard";
export const UNIT_DIR = "/etc/systemd/system";

/** Map component name to its compiled binary filename. */
export function binaryBaseName(component: Component): string {
  if (component === "infoserver") return "xinity-infoserver";
  if (component === "tether") return "xinity-tether";
  return `xinity-ai-${component}`;
}

export type InstallResult = {
  success: boolean;
  version: string;
  errors: string[];
}

export type RemoveResult = {
  success: boolean;
  errors: string[];
}

const COMMON_DEFAULTS = { INFOSERVER_URL: "https://sysinfo.xinity.ai" };

const AUTO_DEFAULTS: Record<Component, Record<string, string>> = {
  gateway: { ...COMMON_DEFAULTS },
  daemon: { ...COMMON_DEFAULTS, STATE_DIR: "/var/lib/xinity-ai-daemon" },
  dashboard: { ...COMMON_DEFAULTS, NODE_ENV: "production", HTTP_PORT: "5173" },
  infoserver: {},
  tether: {},
};

/**
 * Sensible auto-defaults derived from the systemd unit configuration.
 * Used as lowest-priority defaults during env prompting; existing config
 * file values always take precedence.
 */
export function getAutoDefaults(component: Component): Record<string, string> {
  return AUTO_DEFAULTS[component];
}
