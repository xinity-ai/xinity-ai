import { type Component, ENV_DIR, SECRETS_DIR, UNIT_DIR } from "./component-meta.ts";
import { serializeEnvFile } from "./env-file.ts";
import { generateUnit, getComponentConfig, unitName, type UnitConfig } from "./systemd.ts";
import { type Host, isUnitActiveOn, getUnitStatusOn } from "./host.ts";
import type { StepEvent } from "./step-event.ts";

export interface ServiceResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

function applyEnvDerivations(component: Component, config: Record<string, string>): Record<string, string> {
  if (component === "dashboard" && config.ORIGIN) {
    return { ...config, HTTP_OVERRIDE_ORIGIN: config.ORIGIN };
  }
  return config;
}

export async function writeEnvConfig(
  component: Component,
  config: Record<string, string>,
  secrets: Record<string, string>,
  host: Host,
): Promise<ServiceResult> {
  const envContent = serializeEnvFile(applyEnvDerivations(component, config));
  const envPath = `${ENV_DIR}/${component}.env`;
  let result = await host.withElevation(
    `mkdir -p ${ENV_DIR} && cat > ${envPath} << 'ENVEOF'\n${envContent}ENVEOF\nchmod 644 ${envPath}`,
    `Write ${component} configuration`,
  );
  if (!result.success && !result.skipped) {
    return { success: false, error: result.output };
  }

  if (Object.keys(secrets).length > 0) {
    const cmds = [`mkdir -p ${SECRETS_DIR}`, `chmod 700 ${SECRETS_DIR}`];
    for (const [key, value] of Object.entries(secrets)) {
      cmds.push(`printf '%s' '${value.replace(/'/g, "'\\''")}' > ${SECRETS_DIR}/${key}`);
      cmds.push(`chmod 600 ${SECRETS_DIR}/${key}`);
    }
    result = await host.withElevation(cmds.join(" && "), "Write secrets", { sensitive: true });
    if (!result.success && !result.skipped) {
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
  const baseConfig = getComponentConfig(component);
  const config: UnitConfig = { ...baseConfig, secretKeys };

  const unitContent = generateUnit(config);
  const unitPath = `${UNIT_DIR}/${unitName(component)}`;

  const result = await host.withElevation(
    `cat > ${unitPath} << 'UNITEOF'\n${unitContent}UNITEOF\nsystemctl daemon-reload`,
    `Install ${component} systemd unit`,
  );

  if (!result.success && !result.skipped) {
    return { success: false, error: result.output };
  }
  if (result.skipped) {
    return { success: false, skipped: true };
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

  if (!result.success && !result.skipped) {
    yield { type: "fail", label: "Service", detail: result.output };
    return false;
  }
  if (result.skipped) {
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
    return false;
  }

  yield { type: "info", label: "Service", detail: `Restarting ${unit} to apply new configuration…` };

  const result = await host.withElevation(
    `systemctl restart ${unit}`,
    `Restart ${unit}`,
  );

  if (!result.success) {
    if (!result.skipped) {
      yield { type: "fail", label: "Service", detail: result.output };
    }
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
