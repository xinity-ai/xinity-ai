/**
 * Static metadata for Xinity service components.
 *
 * Types, constants, env schema registry, and path conventions used across
 * the CLI. Zero runtime dependencies, intentionally kept side-effect-free
 * so any module can import without pulling in install/service logic.
 */

import { entryFor, type AnyConfig } from "common-env";
import { gatewayConfig } from "xinity-ai-gateway/src/config-schema.ts";
import { tetherConfig } from "xinity-tether/src/config-schema.ts";
import { infoserverConfig } from "xinity-infoserver/config-schema.ts";
import { daemonConfig } from "xinity-ai-daemon/src/config-schema.ts";
import { dashboardConfig } from "xinity-ai-dashboard/src/lib/server/config-schema.ts";

export type { Release } from "./github.ts";

export type Component = "gateway" | "dashboard" | "daemon" | "infoserver" | "tether";

export const COMPONENTS: readonly Component[] = ["gateway", "dashboard", "daemon", "infoserver", "tether"];

export const COMPONENT_CONFIGS: Record<Component, AnyConfig> = {
  gateway: gatewayConfig,
  tether: tetherConfig,
  infoserver: infoserverConfig,
  daemon: daemonConfig,
  dashboard: dashboardConfig,
};

function declaredDefault(config: AnyConfig, envKey: string): unknown {
  const entry = entryFor(config, envKey);
  if (!entry) {
    throw new Error(`${envKey} is not declared`);
  }
  return entry.schema.parse(undefined);
}

/** Listen ports assumed when PORT is not configured, taken from the declarations. */
export const GATEWAY_DEFAULT_PORT = String(declaredDefault(gatewayConfig, "PORT"));
export const INFOSERVER_DEFAULT_PORT = String(declaredDefault(infoserverConfig, "PORT"));
export const TETHER_DEFAULT_PORT = String(declaredDefault(tetherConfig, "PORT"));
export const DASHBOARD_DEFAULT_PORT = String(declaredDefault(dashboardConfig, "HTTP_PORT"));

/** Where the daemon probes for ollama when OLLAMA_URL is left unset. */
export const DEFAULT_OLLAMA_URL = String(declaredDefault(daemonConfig, "OLLAMA_URL"));

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

/** Only what a packaged install needs beyond the declarations: restating one would pin it. */
const AUTO_DEFAULTS: Record<Component, Record<string, string>> = {
  gateway: {},
  daemon: { STATE_DIR: "/var/lib/xinity-ai-daemon" },
  dashboard: { NODE_ENV: "production" },
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

// Declared defaults that suit local development and nothing else. The editor asks for these
// outright rather than marking them, since a marker is only seen by someone already looking.
const ATTENTION_KEYS: Partial<Record<Component, readonly string[]>> = {
  dashboard: ["ORIGIN", "GATEWAY_URL"],
};

export function attentionKeysFor(component: Component): Set<string> {
  return new Set(ATTENTION_KEYS[component] ?? []);
}
