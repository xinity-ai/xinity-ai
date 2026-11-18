import { UNIT_DIR, type Component } from "../core/component-meta.ts";
import type { Host, RunResult } from "../core/host.ts";
import type { HostOs } from "../core/platform.ts";
import { generateUnit, getComponentConfig, unitName } from "./systemd.ts";
import { LAUNCH_DAEMONS_DIR, generatePlist, launchdLabel, launchdLogPath, stateDirOf } from "./launchd.ts";

export type ServiceStatus = { active: boolean; state: string };

export type ServiceEnv = { config: Record<string, string>; secretKeys: string[] };

export type ServiceManager = {
  tool: string;
  name: string;
  definitionKind: string;
  serviceName: (component: Component) => string;
  definitionPath: (component: Component) => string;
  definitionContent: (component: Component, env: ServiceEnv) => string;
  /** Root command that makes a written or restored definition take effect. */
  afterDefinitionWrite: (component: Component) => string;
  startCommand: (component: Component) => string;
  /** Picks up the current definition, which on launchd carries the configuration. */
  restartCommand: (component: Component) => string;
  stopCommand: (component: Component) => string;
  /** Stops the service and keeps it from starting at boot, leaving its definition in place. */
  disableCommand: (component: Component) => string;
  removeDefinitionCommand: (component: Component) => string;
  resetStateCommand: (component: Component) => string;
  statusArgs: (component: Component) => string[];
  parseStatus: (result: RunResult) => ServiceStatus;
  /** Log files the service manager writes itself, removed on purge. */
  logFiles: (component: Component) => string[];
  logArgs: (component: Component) => string[];
  diagnoseCommands: (component: Component) => string[];
};

const systemd: ServiceManager = {
  tool: "systemctl",
  name: "systemd",
  definitionKind: "systemd unit",
  serviceName: unitName,
  definitionPath: (component) => `${UNIT_DIR}/${unitName(component)}`,
  definitionContent: (component, env) => generateUnit({ ...getComponentConfig(component), secretKeys: env.secretKeys }),
  afterDefinitionWrite: () => "systemctl daemon-reload",
  startCommand: (component) => `systemctl enable --now ${unitName(component)}`,
  restartCommand: (component) => `systemctl restart ${unitName(component)}`,
  stopCommand: (component) => `systemctl stop ${unitName(component)}`,
  disableCommand: (component) =>
    `systemctl disable --now ${unitName(component)} && { systemctl reset-failed ${unitName(component)} 2>/dev/null || true; }`,
  removeDefinitionCommand: (component) => `rm -f ${UNIT_DIR}/${unitName(component)} && systemctl daemon-reload`,
  resetStateCommand: (component) => `systemctl clean --what=state ${unitName(component)}`,
  statusArgs: (component) => ["systemctl", "is-active", unitName(component)],
  parseStatus: (result) => ({ active: result.ok, state: result.output || "inactive" }),
  logFiles: () => [],
  logArgs: (component) => ["journalctl", "-u", unitName(component), "--no-pager", "-n", "20"],
  diagnoseCommands: (component) => [`systemctl status ${unitName(component)}`, `journalctl -u ${unitName(component)} -e --no-pager`],
};

const launchdTarget = (component: Component) => `system/${launchdLabel(component)}`;
const plistPath = (component: Component) => `${LAUNCH_DAEMONS_DIR}/${launchdLabel(component)}.plist`;
// launchctl cannot delete an override once written, so only a job disabled after a failed start
// gets enabled again. Older macOS prints a disabled job as "=> true".
const enableIfDisabled = (component: Component) =>
  `{ launchctl print-disabled system | grep -qE '"${launchdLabel(component)}" => (disabled|true)' && launchctl enable ${launchdTarget(component)}; }`;
const bootstrap = (component: Component) =>
  `${enableIfDisabled(component)}; launchctl bootstrap system ${plistPath(component)}`;

const launchd: ServiceManager = {
  tool: "launchctl",
  name: "launchd",
  definitionKind: "launchd job",
  serviceName: launchdLabel,
  definitionPath: plistPath,
  definitionContent: (component, env) => generatePlist(component, env.config, env.secretKeys),
  afterDefinitionWrite: (component) => `chmod 644 ${plistPath(component)} && mkdir -p ${stateDirOf(component)}`,
  startCommand: bootstrap,
  restartCommand: (component) => `launchctl bootout ${launchdTarget(component)} 2>/dev/null; ${bootstrap(component)}`,
  stopCommand: (component) => `launchctl bootout ${launchdTarget(component)}`,
  disableCommand: (component) =>
    `launchctl bootout ${launchdTarget(component)} 2>/dev/null; launchctl disable ${launchdTarget(component)}`,
  removeDefinitionCommand: (component) => `${enableIfDisabled(component)}; rm -f ${plistPath(component)}`,
  resetStateCommand: (component) => `rm -rf ${stateDirOf(component)} && mkdir -p ${stateDirOf(component)}`,
  statusArgs: (component) => ["launchctl", "print", launchdTarget(component)],
  parseStatus: (result) => {
    if (!result.ok) {
      return { active: false, state: "not loaded" };
    }
    const state = result.output.match(/^\tstate = (.+)$/m)?.[1]?.trim() ?? "unknown";
    return { active: state === "running", state };
  },
  logFiles: (component) => [launchdLogPath(component)],
  logArgs: (component) => ["tail", "-n", "20", launchdLogPath(component)],
  diagnoseCommands: (component) => [`launchctl print ${launchdTarget(component)}`, `tail -n 50 ${launchdLogPath(component)}`],
};

export const SERVICE_MANAGERS: Record<HostOs, ServiceManager> = { linux: systemd, darwin: launchd };

export function serviceManagerOf(host: Pick<Host, "os">): ServiceManager {
  return SERVICE_MANAGERS[host.os];
}

export async function serviceStatusOn(host: Host, component: Component): Promise<ServiceStatus> {
  const manager = serviceManagerOf(host);
  return manager.parseStatus(await host.run(manager.statusArgs(component)));
}

export async function isServiceActiveOn(host: Host, component: Component): Promise<boolean> {
  return (await serviceStatusOn(host, component)).active;
}
