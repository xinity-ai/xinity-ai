/**
 * Systemd unit file generation for Xinity services.
 *
 * Gateway/dashboard use DynamicUser=yes with security hardening.
 * Daemon runs as root (needs to manage systemd units, file permissions, etc.).
 *
 * All services use EnvironmentFile for config and LoadCredential for secrets
 * (wired to common-env's KEY_FILE resolution via %d).
 */

export interface UnitConfig {
  component: string;
  description: string;
  execStart: string;
  secretKeys: string[];
  afterUnits?: string[];
  /** When true, the unit runs as root with no sandboxing. */
  runAsRoot?: boolean;
}

const COMPONENT_CONFIGS: Record<string, Omit<UnitConfig, "secretKeys">> = {
  gateway: {
    component: "gateway",
    description: "Xinity AI Gateway",
    execStart: "/opt/xinity/bin/xinity-ai-gateway",
    afterUnits: ["network-online.target"],
  },
  dashboard: {
    component: "dashboard",
    description: "Xinity AI Dashboard",
    execStart: "bun run /opt/xinity/dashboard/",
    afterUnits: ["network-online.target"],
  },
  daemon: {
    component: "daemon",
    description: "Xinity AI Daemon",
    execStart: "/opt/xinity/bin/xinity-ai-daemon",
    afterUnits: ["network-online.target"],
    runAsRoot: true,
  },
  infoserver: {
    component: "infoserver",
    description: "Xinity Infoserver",
    execStart: "/opt/xinity/bin/xinity-infoserver",
    afterUnits: ["network-online.target"],
  },
};

/** Get the base config for a known component. */
export function getComponentConfig(component: string): Omit<UnitConfig, "secretKeys"> {
  const config = COMPONENT_CONFIGS[component];
  if (!config) throw new Error(`Unknown component: ${component}`);
  return config;
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
  lines.push(`EnvironmentFile=/etc/xinity-ai/${config.component}.env`);

  // Secrets via LoadCredential (read by PID 1 from /etc/xinity-ai/secrets/)
  for (const key of config.secretKeys) {
    lines.push(`LoadCredential=${key}:/etc/xinity-ai/secrets/${key}`);
  }
  // Wire LoadCredential to common-env's _FILE resolution (%d = credentials dir)
  for (const key of config.secretKeys) {
    lines.push(`Environment=${key}_FILE=%d/${key}`);
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
export function unitName(component: string): string {
  return `xinity-ai-${component}.service`;
}
