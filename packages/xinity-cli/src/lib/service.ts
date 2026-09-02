import { type Component, ENV_DIR, SECRETS_DIR, UNIT_DIR } from "./component-meta.ts";
import { serializeEnvFile } from "./env-file.ts";
import { generateUnit, getComponentConfig, unitName, type UnitConfig } from "./systemd.ts";
import { type Host, isUnitActiveOn, getUnitStatusOn } from "./host.ts";
import type { StepEvent } from "./step-event.ts";

export type ServiceResult = {
  success: boolean;
  error?: string;
}

function applyEnvDerivations(component: Component, config: Record<string, string>): Record<string, string> {
  if (component === "dashboard" && config.ORIGIN) {
    return { ...config, HTTP_OVERRIDE_ORIGIN: config.ORIGIN };
  }
  return config;
}

// The build*Command helpers return the exact root shell commands the apply
// runs; the review phase's script dump emits the same strings verbatim.

export function heredoc(tag: string, content: string): string {
  const sentinel = `${tag}_${Math.random().toString(16).slice(2, 10)}`;
  return `<< '${sentinel}'\n${content}\n${sentinel}`;
}

export function buildEnvWriteCommand(component: Component, config: Record<string, string>): string {
  const envContent = serializeEnvFile(applyEnvDerivations(component, config));
  const envPath = `${ENV_DIR}/${component}.env`;
  return `mkdir -p ${ENV_DIR} && cat > ${envPath} ${heredoc("ENVEOF", envContent)}\nchmod 644 ${envPath}`;
}

export function buildSecretsWriteCommand(secrets: Record<string, string>): string | null {
  if (Object.keys(secrets).length === 0) return null;
  const cmds = [`mkdir -p ${SECRETS_DIR}`, `chmod 700 ${SECRETS_DIR}`];
  for (const [key, value] of Object.entries(secrets)) {
    cmds.push(`printf '%s' '${value.replace(/'/g, "'\\''")}' > ${SECRETS_DIR}/${key}`);
    cmds.push(`chmod 600 ${SECRETS_DIR}/${key}`);
  }
  return cmds.join(" && ");
}

export function buildSecretsRemoveCommand(keys: string[]): string | null {
  if (keys.length === 0) return null;
  return `rm -f ${keys.map((key) => `${SECRETS_DIR}/${key}`).join(" ")}`;
}

export function buildUnitWriteCommand(component: Component, secretKeys: string[]): string {
  const baseConfig = getComponentConfig(component);
  const config: UnitConfig = { ...baseConfig, secretKeys };
  const unitContent = generateUnit(config);
  const unitPath = `${UNIT_DIR}/${unitName(component)}`;
  return `cat > ${unitPath} ${heredoc("UNITEOF", unitContent)}\nsystemctl daemon-reload`;
}

export async function writeEnvConfig(
  component: Component,
  config: Record<string, string>,
  secrets: Record<string, string>,
  host: Host,
  removeSecretKeys: string[] = [],
): Promise<ServiceResult> {
  let result = await host.withElevation(
    buildEnvWriteCommand(component, config),
    `Write ${component} configuration`,
  );
  if (!result.success) {
    return { success: false, error: result.output };
  }

  const secretsCommand = buildSecretsWriteCommand(secrets);
  if (secretsCommand) {
    result = await host.withElevation(secretsCommand, "Write secrets");
    if (!result.success) {
      return { success: false, error: result.output };
    }
  }

  const removeCommand = buildSecretsRemoveCommand(removeSecretKeys);
  if (removeCommand) {
    result = await host.withElevation(removeCommand, "Remove unset secrets");
    if (!result.success) {
      return { success: false, error: result.output };
    }
  }

  return { success: true };
}

export async function writeSystemdUnit(
  component: Component,
  secretKeys: string[],
  host: Host,
): Promise<ServiceResult> {
  const result = await host.withElevation(
    buildUnitWriteCommand(component, secretKeys),
    `Install ${component} systemd unit`,
  );

  if (!result.success) {
    return { success: false, error: result.output };
  }

  return { success: true };
}

export async function stopService(component: Component, host: Host): Promise<void> {
  const unit = unitName(component);
  if (await isUnitActiveOn(host, unit)) {
    await host.withElevation(`systemctl stop ${unit}`, `Stop ${unit}`);
  }
}

const UNIT_ACTIVE_POLL_INTERVAL_MS = 500;
const UNIT_ACTIVE_POLL_ATTEMPTS = 10;

export async function waitForUnitActive(host: Host, unit: string): Promise<boolean> {
  for (let i = 0; i < UNIT_ACTIVE_POLL_ATTEMPTS; i++) {
    await Bun.sleep(UNIT_ACTIVE_POLL_INTERVAL_MS);
    if (await isUnitActiveOn(host, unit)) {
      return true;
    }
  }
  return false;
}

async function collectJournalLines(host: Host, unit: string): Promise<string | null> {
  const journal = await host.run(["journalctl", "-u", unit, "--no-pager", "-n", "20"]);
  return journal.ok ? journal.output : null;
}

export async function* startService(component: Component, host: Host): AsyncGenerator<StepEvent, boolean> {
  const unit = unitName(component);
  const result = await host.withElevation(
    `systemctl enable --now ${unit}`,
    `Enable and start ${unit}`,
  );

  if (!result.success) {
    yield { type: "fail", label: "Service", detail: result.output };
    return false;
  }

  yield { type: "spinner", id: "service-start", message: "Waiting for service to start…" };
  const active = await waitForUnitActive(host, unit);
  yield { type: "spinner", id: "service-start", message: active ? "Service running" : "Service failed to start", done: true };

  if (active) {
    yield { type: "pass", label: "Service", detail: `${unit} is active` };
    return true;
  }

  const status = await getUnitStatusOn(host, unit);
  yield { type: "fail", label: "Service", detail: `${unit} is ${status}` };
  const journal = await collectJournalLines(host, unit);
  if (journal) {
    yield { type: "log", message: journal };
  }
  return false;
}

export async function* restartService(component: Component, host: Host): AsyncGenerator<StepEvent, boolean> {
  const unit = unitName(component);
  if (!(await isUnitActiveOn(host, unit))) {
    const status = await getUnitStatusOn(host, unit);
    yield { type: "fail", label: "Service", detail: `${unit} is ${status} (cannot restart)` };
    const journal = await collectJournalLines(host, unit);
    if (journal) {
      yield { type: "log", message: journal };
    }
    return false;
  }

  yield { type: "info", label: "Service", detail: `Restarting ${unit} to apply new configuration…` };

  const result = await host.withElevation(
    `systemctl restart ${unit}`,
    `Restart ${unit}`,
  );

  if (!result.success) {
    yield { type: "fail", label: "Service", detail: result.output };
    return false;
  }

  yield { type: "spinner", id: "service-restart", message: "Waiting for service to restart…" };
  const active = await waitForUnitActive(host, unit);
  yield { type: "spinner", id: "service-restart", message: active ? "Service restarted" : "Service failed to restart", done: true };

  if (active) {
    yield { type: "pass", label: "Service", detail: `${unit} restarted with new configuration` };
    return true;
  }

  const status = await getUnitStatusOn(host, unit);
  yield { type: "fail", label: "Service", detail: `${unit} is ${status} after restart` };
  const journal = await collectJournalLines(host, unit);
  if (journal) {
    yield { type: "log", message: journal };
  }
  return false;
}
