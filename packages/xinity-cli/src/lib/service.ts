/**
 * Service lifecycle management for Xinity systemd services.
 *
 * Handles writing env configuration, starting, stopping, and restarting
 * services. Used both by the install orchestrator and standalone by
 * the configure command.
 */
import * as p from "./clack.ts";
import pc from "picocolors";

import { type Component, ENV_DIR, SECRETS_DIR } from "./component-meta.ts";
import { serializeEnvFile } from "./env-file.ts";
import { unitName } from "./systemd.ts";
import { pass, fail, info } from "./output.ts";
import { type Host, createLocalHost, isUnitActiveOn, getUnitStatusOn } from "./host.ts";

/** Write component env config and secret files to disk via host elevation. */
export async function writeEnvConfig(
  component: Component,
  config: Record<string, string>,
  secrets: Record<string, string>,
  host: Host = createLocalHost(),
): Promise<boolean> {
  // Write config env file
  const envContent = serializeEnvFile(config);
  const envPath = `${ENV_DIR}/${component}.env`;
  let result = await host.withElevation(
    `mkdir -p ${ENV_DIR} && cat > ${envPath} << 'ENVEOF'\n${envContent}ENVEOF\nchmod 644 ${envPath}`,
    `Write ${component} configuration`,
  );
  if (!result.success && !result.skipped) {
    fail("Config", result.output);
    return false;
  }

  // Write secret files
  if (Object.keys(secrets).length > 0) {
    const cmds = [`mkdir -p ${SECRETS_DIR}`, `chmod 700 ${SECRETS_DIR}`];
    for (const [key, value] of Object.entries(secrets)) {
      // Use printf to avoid newline interpretation issues
      cmds.push(`printf '%s' '${value.replace(/'/g, "'\\''")}' > ${SECRETS_DIR}/${key}`);
      cmds.push(`chmod 600 ${SECRETS_DIR}/${key}`);
    }
    result = await host.withElevation(cmds.join(" && "), "Write secrets", { sensitive: true });
    if (!result.success && !result.skipped) {
      fail("Secrets", result.output);
      return false;
    }
  }

  pass("Config", "Environment configured");
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

/** Enable and start a service, wait for it to stabilize. */
export async function startService(component: Component, host: Host): Promise<boolean> {
  const unit = unitName(component);
  const result = await host.withElevation(
    `systemctl enable --now ${unit}`,
    `Enable and start ${unit}`,
  );

  if (!result.success && !result.skipped) {
    fail("Service", result.output);
    return false;
  }
  if (result.skipped) return false;

  // Poll until the service is active or we've waited long enough
  const spinner = p.spinner();
  spinner.start("Waiting for service to start…");
  let active = false;
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(500);
    active = await isUnitActiveOn(host, unit);
    if (active) break;
  }
  if (active) {
    spinner.stop("Service running");
    pass("Service", `${unit} is active`);
    return true;
  }

  spinner.stop("Service failed to start");
  const status = await getUnitStatusOn(host, unit);
  fail("Service", `${unit} is ${status}`);

  // Show recent journal output
  const journal = await host.run(["journalctl", "-u", unit, "--no-pager", "-n", "20"]);
  if (journal.ok) {
    p.log.info(pc.dim(journal.output));
  }
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

  const spinner = p.spinner();
  spinner.start("Waiting for service to restart…");
  let active = false;
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(500);
    active = await isUnitActiveOn(host, unit);
    if (active) break;
  }
  if (active) {
    spinner.stop("Service restarted");
    pass("Service", `${unit} restarted with new configuration`);
    return true;
  }

  spinner.stop("Service failed to restart");
  const status = await getUnitStatusOn(host, unit);
  fail("Service", `${unit} is ${status} after restart`);
  const journal = await host.run(["journalctl", "-u", unit, "--no-pager", "-n", "20"]);
  if (journal.ok) {
    p.log.info(pc.dim(journal.output));
  }
  return false;
}
