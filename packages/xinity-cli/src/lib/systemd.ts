/**
 * Systemd unit file generation for Xinity services.
 *
 * Gateway/dashboard use DynamicUser=yes with security hardening.
 * Daemon runs as root (needs to manage systemd units, file permissions, etc.).
 *
 * All services use EnvironmentFile for config and LoadCredential for secrets
 * (wired to common-env's KEY_FILE resolution via %d).
 */
import { BIN_DIR, ENV_DIR, SECRETS_DIR, binaryBaseName, type Component } from "./component-meta.ts";

export interface UnitConfig {
  component: string;
  description: string;
  execStart: string;
  secretKeys: string[];
  afterUnits?: string[];
  /** When true, the unit runs as root with no sandboxing. */
  runAsRoot?: boolean;
}

type ComponentDefaults = Omit<UnitConfig, "component" | "secretKeys" | "execStart">;

const COMPONENT_CONFIGS: Record<Component, ComponentDefaults> = {
  gateway: {
    description: "Xinity AI Gateway",
    afterUnits: ["network-online.target"],
  },
  dashboard: {
    description: "Xinity AI Dashboard",
    afterUnits: ["network-online.target"],
  },
  daemon: {
    description: "Xinity AI Daemon",
    afterUnits: ["network-online.target"],
    runAsRoot: true,
  },
  infoserver: {
    description: "Xinity Infoserver",
    afterUnits: ["network-online.target"],
  },
  conductor: {
    component: "conductor",
    description: "Xinity Conductor",
    execStart: "/opt/xinity/bin/xinity-conductor",
    afterUnits: ["network-online.target"],
  },
};

/** Get the base config for a known component. */
export function getComponentConfig(component: Component): Omit<UnitConfig, "secretKeys"> {
  return {
    component,
    execStart: `${BIN_DIR}/${binaryBaseName(component)}`,
    ...COMPONENT_CONFIGS[component],
  };
}

/** Generate a complete systemd unit file string. */
export function generateUnit(config: UnitConfig): string {
  const lines: string[] = ["[Unit]", `Description=${config.description}`];

  const after = config.afterUnits ?? ["network-online.target"];
  lines.push(`After=${after.join(" ")}`, `Wants=${after.join(" ")}`);

  lines.push("", "[Service]", "Type=simple");

  if (config.runAsRoot) {
    // Daemon needs root to manage systemd units, file permissions, etc.
    lines.push("User=root");
  } else {
    lines.push("DynamicUser=yes");
  }

  lines.push(`StateDirectory=xinity-ai-${config.component}`);

  // Non-secret config via EnvironmentFile (read by PID 1, no permission issues)
  lines.push(`EnvironmentFile=${ENV_DIR}/${config.component}.env`);

  // LoadCredential reads each secret file as PID 1; the matching Environment wires it
  // to common-env's _FILE resolution (%d = credentials dir at runtime).
  for (const key of config.secretKeys) {
    lines.push(
      `LoadCredential=${key}:${SECRETS_DIR}/${key}`,
      `Environment=${key}_FILE=%d/${key}`,
    );
  }

  lines.push(`ExecStart=${config.execStart}`);
  lines.push("Restart=on-failure", "RestartSec=5");

  // Security hardening (only for sandboxed services)
  if (!config.runAsRoot) {
    lines.push(
      "",
      "# Security",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateTmp=true",
    );
  }

  lines.push("", "[Install]", "WantedBy=multi-user.target");

  return lines.join("\n") + "\n";
}

/** Systemd unit name for a component. */
export function unitName(component: Component): string {
  return `xinity-ai-${component}.service`;
}
