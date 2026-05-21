/**
 * Service lifecycle management for Xinity systemd services.
 *
 * Handles writing env configuration, starting, stopping, and restarting
 * services. Used both by the install orchestrator and standalone by
 * the configure command.
 */
import * as p from "./clack.ts";
import pc from "picocolors";

import { type Component, ENV_DIR, SECRETS_DIR, UNIT_DIR } from "./component-meta.ts";
import { serializeEnvFile } from "./env-file.ts";
import { generateUnit, getComponentConfig, unitName, type UnitConfig } from "./systemd.ts";
import { pass, fail, info, elevationHardFailed } from "./output.ts";
import { type Host, createLocalHost, isUnitActiveOn, getUnitStatusOn } from "./host.ts";

function applyEnvDerivations(component: Component, config: Record<string, string>): Record<string, string> {
  if (component === "dashboard" && config.ORIGIN) {
    return { ...config, HTTP_OVERRIDE_ORIGIN: config.ORIGIN };
  }
  return config;
}

/** Write component env config and secret files to disk via host elevation. */
export async function writeEnvConfig(
  component: Component,
  config: Record<string, string>,
  secrets: Record<string, string>,
  host: Host = createLocalHost(),
): Promise<boolean> {
  // Write config env file
  const envContent = serializeEnvFile(applyEnvDerivations(component, config));
  const envPath = `${ENV_DIR}/${component}.env`;
  let result = await host.withElevation(
    `mkdir -p ${ENV_DIR} && cat > ${envPath} << 'ENVEOF'\n${envContent}ENVEOF\nchmod 644 ${envPath}`,
    `Write ${component} configuration`,
  );
  if (elevationHardFailed(result, "Config")) return false;

  // Write secret files
  if (Object.keys(secrets).length > 0) {
    const cmds = [`mkdir -p ${SECRETS_DIR}`, `chmod 700 ${SECRETS_DIR}`];
    for (const [key, value] of Object.entries(secrets)) {
      // Use printf to avoid newline interpretation issues
      cmds.push(`printf '%s' '${value.replace(/'/g, "'\\''")}' > ${SECRETS_DIR}/${key}`);
      cmds.push(`chmod 600 ${SECRETS_DIR}/${key}`);
    }
    result = await host.withElevation(cmds.join(" && "), "Write secrets", { sensitive: true });
    if (elevationHardFailed(result, "Secrets")) return false;
  }

  pass("Config", "Environment configured");
  return true;
}

/**
 * Generate the systemd unit for a component and write it to /etc/systemd/system,
 * then daemon-reload. 
 */
export async function writeSystemdUnit(
  component: Component,
  secretKeys: string[],
  host: Host = createLocalHost(),
): Promise<boolean> {
  const baseConfig = getComponentConfig(component);
  const config: UnitConfig = { ...baseConfig, secretKeys };

  const unitContent = generateUnit(config);
  const unitPath = `${UNIT_DIR}/${unitName(component)}`;

  const result = await host.withElevation(
    `cat > ${unitPath} << 'UNITEOF'\n${unitContent}UNITEOF\nsystemctl daemon-reload`,
    `Install ${component} systemd unit`,
  );

  if (elevationHardFailed(result, "Systemd")) return false;
  if (result.skipped) return false;

  pass("Systemd", `Unit installed at ${unitPath}`);
  return true;
}

/** Stop a running service. No-op if not active. */
export async function stopService(component: Component, host: Host): Promise<void> {
  const unit = unitName(component);
  if (await isUnitActiveOn(host, unit)) {
    info("Service", `Stopping ${unit}…`);
    await host.withElevation(`systemctl stop ${unit}`, `Stop ${unit}`);
  }
}

const UNIT_ACTIVE_POLL_INTERVAL_MS = 500;
const UNIT_ACTIVE_POLL_ATTEMPTS = 10;

async function waitForUnitActive(host: Host, unit: string): Promise<boolean> {
  for (let i = 0; i < UNIT_ACTIVE_POLL_ATTEMPTS; i++) {
    await Bun.sleep(UNIT_ACTIVE_POLL_INTERVAL_MS);
    if (await isUnitActiveOn(host, unit)) return true;
  }
  return false;
}

async function reportUnitFailure(host: Host, unit: string, contextSuffix: string): Promise<void> {
  const status = await getUnitStatusOn(host, unit);
  fail("Service", `${unit} is ${status}${contextSuffix}`);
  const journal = await host.run(["journalctl", "-u", unit, "--no-pager", "-n", "20"]);
  if (journal.ok) {
    p.log.info(pc.dim(journal.output));
  }
}

async function awaitUnitActiveWithSpinner(
  host: Host,
  unit: string,
  messages: { pending: string; succeeded: string; failed: string },
): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start(messages.pending);
  if (await waitForUnitActive(host, unit)) {
    spinner.stop(messages.succeeded);
    return true;
  }
  spinner.stop(messages.failed);
  return false;
}

/** Enable and start a service, wait for it to stabilize. */
export async function startService(component: Component, host: Host): Promise<boolean> {
  const unit = unitName(component);
  const result = await host.withElevation(
    `systemctl enable --now ${unit}`,
    `Enable and start ${unit}`,
  );

  if (elevationHardFailed(result, "Service")) return false;
  if (result.skipped) return false;

  const active = await awaitUnitActiveWithSpinner(host, unit, {
    pending: "Waiting for service to start…",
    succeeded: "Service running",
    failed: "Service failed to start",
  });
  if (active) {
    pass("Service", `${unit} is active`);
    return true;
  }
  await reportUnitFailure(host, unit, "");
  return false;
}

/**
 * Restart a running service so it picks up new configuration.
 * No-op if the service unit is not currently active.
 */
export async function restartService(component: Component, host: Host): Promise<boolean> {
  const unit = unitName(component);
  if (!(await isUnitActiveOn(host, unit))) return false;

  info("Service", `Restarting ${unit} to apply new configuration…`);

  const result = await host.withElevation(
    `systemctl restart ${unit}`,
    `Restart ${unit}`,
  );

  if (!result.success) {
    if (!result.skipped) fail("Service", result.output);
    return false;
  }

  const active = await awaitUnitActiveWithSpinner(host, unit, {
    pending: "Waiting for service to restart…",
    succeeded: "Service restarted",
    failed: "Service failed to restart",
  });
  if (active) {
    pass("Service", `${unit} restarted with new configuration`);
    return true;
  }
  await reportUnitFailure(host, unit, " after restart");
  return false;
}
