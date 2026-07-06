import * as p from "./clack.ts";
import pc from "picocolors";
import { readManifest, writeManifest } from "./manifest.ts";
import { analyzeEnvSchema, categorizeFields } from "./env-prompt.ts";
import { type Host, isUnitActiveOn } from "./host.ts";
import { unitName } from "./systemd.ts";
import { runSteps } from "./step-runner.ts";
import type { StepEvent } from "./step-event.ts";
import {
  type Component, type RemoveResult,
  ENV_SCHEMAS, ENV_DIR, SECRETS_DIR, BIN_DIR, DASHBOARD_DIR, UNIT_DIR,
  binaryBaseName,
} from "./component-meta.ts";

function* elevationStep(
  result: { success: boolean; skipped: boolean; output: string },
  label: string,
  successMsg: string,
  failurePrefix: string,
  errors: string[],
): Generator<StepEvent> {
  if (result.success) {
    yield { type: "pass", label, detail: successMsg };
  } else if (!result.skipped) {
    const error = `${failurePrefix}: ${result.output}`;
    errors.push(error);
    yield { type: "fail", label, detail: error };
  }
}

export async function* removeComponent(opts: {
  component: Component;
  purge?: boolean;
  host: Host;
}): AsyncGenerator<StepEvent, RemoveResult> {
  const { component, purge = false, host } = opts;
  const errors: string[] = [];
  const manifest = await readManifest(host);
  const entry = manifest.components[component];

  if (!entry) {
    yield { type: "warn", label: "Not installed", detail: `${component} is not in the manifest` };
  }

  const unit = unitName(component);

  if (await isUnitActiveOn(host, unit)) {
    yield { type: "info", label: "Service", detail: `Stopping ${unit}…` };
    const result = await host.withElevation(
      `systemctl disable --now ${unit}`,
      `Stop and disable ${unit}`,
    );
    yield* elevationStep(result, "Service", `${unit} stopped and disabled`, `Failed to stop ${unit}`, errors);
  } else {
    await host.withElevation(`systemctl disable ${unit} 2>/dev/null || true`, `Disable ${unit}`);
    yield { type: "info", label: "Service", detail: `${unit} was not running` };
  }

  const unitPath = `${UNIT_DIR}/${unit}`;
  const rmUnit = await host.withElevation(
    `rm -f ${unitPath} && systemctl daemon-reload`,
    `Remove ${unit} unit file`,
  );
  yield* elevationStep(rmUnit, "Systemd", `Removed ${unitPath}`, "Failed to remove unit", errors);

  const binaryPath = `${BIN_DIR}/${binaryBaseName(component)}`;
  const rmBin = await host.withElevation(
    component === "dashboard"
      ? `rm -f ${binaryPath} && rm -rf ${DASHBOARD_DIR} 2>/dev/null || true`
      : `rm -f ${binaryPath}`,
    `Remove ${component} binary`,
  );
  yield* elevationStep(rmBin, "Files", `Removed ${binaryPath}`, "Failed to remove binary", errors);

  const envPath = `${ENV_DIR}/${component}.env`;
  const rmEnv = await host.withElevation(
    `rm -f ${envPath}`,
    `Remove ${component} env config`,
  );
  yield* elevationStep(rmEnv, "Config", `Removed ${envPath}`, "Failed to remove env config", errors);

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
      yield { type: "info", label: "Secrets", detail: `Keeping ${kept.map((f) => f.key).join(", ")} (used by other components)` };
    }

    if (toDelete.length > 0) {
      const secretPaths = toDelete.map((f) => `${SECRETS_DIR}/${f.key}`).join(" ");
      const rmSecrets = await host.withElevation(
        `rm -f ${secretPaths}`,
        `Remove ${component} secret files`,
      );
      yield* elevationStep(rmSecrets, "Secrets", `Removed ${toDelete.length} secret file(s)`, "Failed to remove secrets", errors);
    }
  }

  if (component === "daemon") {
    const vllmTemplatePath = `${UNIT_DIR}/vllm-driver@.service`;
    const rmTemplate = await host.withElevation(
      `rm -f ${vllmTemplatePath} && systemctl daemon-reload`,
      "Remove vLLM systemd template unit",
    );
    yield* elevationStep(rmTemplate, "vLLM", `Removed ${vllmTemplatePath}`, "Failed to remove vLLM template", errors);

    if (purge) {
      const rmVllmEnv = await host.withElevation(
        "rm -rf /etc/vllm",
        "Purge vLLM environment config",
      );
      yield* elevationStep(rmVllmEnv, "Purge", "Removed /etc/vllm", "Failed to purge /etc/vllm", errors);
    }
  }

  if (purge) {
    const stateDir = `/var/lib/xinity-ai-${component}`;
    const rmState = await host.withElevation(
      `rm -rf ${stateDir}`,
      `Purge ${component} state data`,
    );
    yield* elevationStep(rmState, "Purge", `Removed ${stateDir}`, "Failed to purge state", errors);
  }

  delete manifest.components[component];
  await writeManifest(manifest, host);
  yield { type: "pass", label: "Manifest", detail: `Removed ${component} from manifest` };

  const success = errors.length === 0;
  if (success) {
    yield { type: "pass", label: "Done", detail: `${component} removed successfully` };
  }

  return { success, errors };
}

export async function removeAll(purge = false, host: Host): Promise<void> {
  const { runComponentSequence } = await import("./installer.ts");

  await runComponentSequence(
    ["gateway", "dashboard", "daemon", "infoserver"],
    (component) => runSteps(removeComponent({ component, purge, host })),
  );

  p.log.step(pc.bold("\n── Cleanup ──"));
  const cleanDirs = [
    `rmdir ${SECRETS_DIR} 2>/dev/null || true`,
    `rmdir ${ENV_DIR} 2>/dev/null || true`,
    `rmdir ${BIN_DIR} 2>/dev/null || true`,
    `rmdir /opt/xinity 2>/dev/null || true`,
  ].join(" && ");
  await host.withElevation(cleanDirs, "Clean up empty directories");
}
