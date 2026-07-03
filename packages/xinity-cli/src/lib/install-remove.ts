import * as p from "./clack.ts";
import pc from "picocolors";
import { readManifest, writeManifest } from "./manifest.ts";
import { analyzeEnvSchema, categorizeFields } from "./env-prompt.ts";
import { pass, warn, info } from "./output.ts";
import { type Host, createLocalHost, isUnitActiveOn } from "./host.ts";
import { unitName } from "./systemd.ts";
import {
  type Component, type RemoveResult,
  ENV_SCHEMAS, ENV_DIR, SECRETS_DIR, BIN_DIR, DASHBOARD_DIR, UNIT_DIR,
  binaryBaseName,
} from "./component-meta.ts";

function reportElevationStep(
  result: { success: boolean; skipped: boolean; output: string },
  label: string,
  successMsg: string,
  failurePrefix: string,
  errors: string[],
): void {
  if (result.success) {
    pass(label, successMsg);
  } else if (!result.skipped) {
    errors.push(`${failurePrefix}: ${result.output}`);
  }
}

export async function removeComponent(opts: {
  component: Component;
  purge?: boolean;
  host?: Host;
}): Promise<RemoveResult> {
  const { component, purge = false } = opts;
  const host = opts.host ?? createLocalHost();
  const errors: string[] = [];
  const manifest = await readManifest(host);
  const entry = manifest.components[component];

  if (!entry) {
    warn("Not installed", `${component} is not in the manifest`);
  }

  const unit = unitName(component);

  if (await isUnitActiveOn(host, unit)) {
    info("Service", `Stopping ${unit}…`);
    const result = await host.withElevation(
      `systemctl disable --now ${unit}`,
      `Stop and disable ${unit}`,
    );
    reportElevationStep(result, "Service", `${unit} stopped and disabled`, `Failed to stop ${unit}`, errors);
  } else {
    await host.withElevation(`systemctl disable ${unit} 2>/dev/null || true`, `Disable ${unit}`);
    info("Service", `${unit} was not running`);
  }

  const unitPath = `${UNIT_DIR}/${unit}`;
  const rmUnit = await host.withElevation(
    `rm -f ${unitPath} && systemctl daemon-reload`,
    `Remove ${unit} unit file`,
  );
  reportElevationStep(rmUnit, "Systemd", `Removed ${unitPath}`, "Failed to remove unit", errors);

  const binaryPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const rmBin = await host.withElevation(
    component === "dashboard"
      ? `rm -f ${binaryPath} && rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`
      : `rm -f ${binaryPath}`,
    `Remove ${component} binary`,
  );
  reportElevationStep(rmBin, "Files", `Removed ${binaryPath}`, "Failed to remove binary", errors);

  const envPath = `${ENV_DIR}/${component}.env`;
  const rmEnv = await host.withElevation(
    `rm -f ${envPath}`,
    `Remove ${component} env config`,
  );
  reportElevationStep(rmEnv, "Config", `Removed ${envPath}`, "Failed to remove env config", errors);

  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
  const { secretFields } = categorizeFields(fields);
  if (secretFields.length > 0) {
    const manifest = await readManifest(host);
    const otherComponents = (Object.keys(ENV_SCHEMAS) as Component[])
      .filter((c) => c !== component && manifest.components[c]);
    const sharedKeys = new Set(
      otherComponents.flatMap((c) => {
        const { secretFields: sf } = categorizeFields(analyzeEnvSchema(ENV_SCHEMAS[c]));
        return sf.map((f) => f.key);
      }),
    );

    const toDelete = secretFields.filter((f) => !sharedKeys.has(f.key));
    const kept = secretFields.filter((f) => sharedKeys.has(f.key));

    if (kept.length > 0) {
      info("Secrets", `Keeping ${kept.map((f) => f.key).join(", ")} (used by other components)`);
    }

    if (toDelete.length > 0) {
      const secretPaths = toDelete.map((f) => `${SECRETS_DIR}/${f.key}`).join(" ");
      const rmSecrets = await host.withElevation(
        `rm -f ${secretPaths}`,
        `Remove ${component} secret files`,
      );
      reportElevationStep(rmSecrets, "Secrets", `Removed ${toDelete.length} secret file(s)`, "Failed to remove secrets", errors);
    }
  }

  if (component === "daemon") {
    const vllmTemplatePath = `${UNIT_DIR}/vllm-driver@.service`;
    const rmTemplate = await host.withElevation(
      `rm -f ${vllmTemplatePath} && systemctl daemon-reload`,
      "Remove vLLM systemd template unit",
    );
    reportElevationStep(rmTemplate, "vLLM", `Removed ${vllmTemplatePath}`, "Failed to remove vLLM template", errors);

    if (purge) {
      const rmVllmEnv = await host.withElevation(
        "rm -rf /etc/vllm",
        "Purge vLLM environment config",
      );
      reportElevationStep(rmVllmEnv, "Purge", "Removed /etc/vllm", "Failed to purge /etc/vllm", errors);
    }
  }

  if (purge) {
    const stateDir = `/var/lib/xinity-ai-${component}`;
    const rmState = await host.withElevation(
      `rm -rf ${stateDir}`,
      `Purge ${component} state data`,
    );
    reportElevationStep(rmState, "Purge", `Removed ${stateDir}`, "Failed to purge state", errors);
  }

  delete manifest.components[component];
  await writeManifest(manifest, host);
  pass("Manifest", `Removed ${component} from manifest`);

  const success = errors.length === 0;
  if (success) {
    pass("Done", `${component} removed successfully`);
  }

  return { success, errors };
}

export async function removeAll(purge = false, host?: Host): Promise<void> {
  const h = host ?? createLocalHost();
  const { runComponentSequence } = await import("./installer.ts");

  await runComponentSequence(
    ["gateway", "dashboard", "daemon", "infoserver"],
    (component) => removeComponent({ component, purge, host: h }),
  );

  p.log.step(pc.bold("\n── Cleanup ──"));
  const cleanDirs = [
    `rmdir ${SECRETS_DIR} 2>/dev/null || true`,
    `rmdir ${ENV_DIR} 2>/dev/null || true`,
    `rmdir ${BIN_DIR} 2>/dev/null || true`,
    `rmdir /opt/xinity 2>/dev/null || true`,
  ].join(" && ");
  await h.withElevation(cleanDirs, "Clean up empty directories");
}
