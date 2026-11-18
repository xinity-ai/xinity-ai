import { type Component, ENV_DIR, SECRETS_DIR } from "../core/component-meta.ts";
import { serializeEnvFile } from "../config/env-file.ts";
import type { Host } from "../core/host.ts";
import type { StepEvent } from "../term/step-event.ts";
import { type ServiceEnv, type ServiceManager, isServiceActiveOn, serviceManagerOf, serviceStatusOn } from "./service-manager.ts";

export type ServiceResult = {
  success: boolean;
  error?: string;
}

// The build*Command helpers return the exact root shell commands the apply
// runs; the review phase's script dump emits the same strings verbatim.

export function heredoc(tag: string, content: string): string {
  const sentinel = `${tag}_${Math.random().toString(16).slice(2, 10)}`;
  return `<< '${sentinel}'\n${content}\n${sentinel}`;
}

export function buildEnvWriteCommand(component: Component, config: Record<string, string>): string {
  const envContent = serializeEnvFile(config);
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

export function buildServiceDefinitionCommand(manager: ServiceManager, component: Component, env: ServiceEnv): string {
  const content = manager.definitionContent(component, env);
  return `cat > ${manager.definitionPath(component)} ${heredoc("UNITEOF", content)}\n${manager.afterDefinitionWrite(component)}`;
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

export async function writeServiceDefinition(component: Component, env: ServiceEnv, host: Host): Promise<ServiceResult> {
  const manager = serviceManagerOf(host);
  const result = await host.withElevation(
    buildServiceDefinitionCommand(manager, component, env),
    `Install ${component} ${manager.definitionKind}`,
  );
  return result.success ? { success: true } : { success: false, error: result.output };
}

export async function stopService(component: Component, host: Host): Promise<void> {
  const manager = serviceManagerOf(host);
  if (await isServiceActiveOn(host, component)) {
    await host.withElevation(manager.stopCommand(component), `Stop ${manager.serviceName(component)}`);
  }
}

const SERVICE_ACTIVE_POLL_INTERVAL_MS = 500;
const SERVICE_ACTIVE_POLL_ATTEMPTS = 10;

async function waitForServiceActive(host: Host, component: Component): Promise<boolean> {
  for (let i = 0; i < SERVICE_ACTIVE_POLL_ATTEMPTS; i++) {
    await Bun.sleep(SERVICE_ACTIVE_POLL_INTERVAL_MS);
    if (await isServiceActiveOn(host, component)) {
      return true;
    }
  }
  return false;
}

async function* reportInactive(host: Host, component: Component, suffix: string): AsyncGenerator<StepEvent> {
  const manager = serviceManagerOf(host);
  const { state } = await serviceStatusOn(host, component);
  yield { type: "fail", label: "Service", detail: `${manager.serviceName(component)} is ${state}${suffix}` };
  const logs = await host.run(manager.logArgs(component));
  if (logs.ok && logs.output) {
    yield { type: "log", message: logs.output };
  }
}

export async function* startService(component: Component, host: Host): AsyncGenerator<StepEvent, boolean> {
  const manager = serviceManagerOf(host);
  const name = manager.serviceName(component);
  const result = await host.withElevation(manager.startCommand(component), `Enable and start ${name}`);

  if (!result.success) {
    yield { type: "fail", label: "Service", detail: result.output };
    return false;
  }

  yield { type: "spinner", id: "service-start", message: "Waiting for service to start…" };
  const active = await waitForServiceActive(host, component);
  yield { type: "spinner", id: "service-start", message: active ? "Service running" : "Service failed to start", done: true };

  if (active) {
    yield { type: "pass", label: "Service", detail: `${name} is active` };
    return true;
  }

  yield* reportInactive(host, component, "");
  return false;
}

export async function* restartService(component: Component, host: Host): AsyncGenerator<StepEvent, boolean> {
  const manager = serviceManagerOf(host);
  const name = manager.serviceName(component);
  if (!(await isServiceActiveOn(host, component))) {
    yield* reportInactive(host, component, " (cannot restart)");
    return false;
  }

  yield { type: "info", label: "Service", detail: `Restarting ${name} to apply new configuration…` };

  const result = await host.withElevation(manager.restartCommand(component), `Restart ${name}`);
  if (!result.success) {
    yield { type: "fail", label: "Service", detail: result.output };
    return false;
  }

  yield { type: "spinner", id: "service-restart", message: "Waiting for service to restart…" };
  const active = await waitForServiceActive(host, component);
  yield { type: "spinner", id: "service-restart", message: active ? "Service restarted" : "Service failed to restart", done: true };

  if (active) {
    yield { type: "pass", label: "Service", detail: `${name} restarted with new configuration` };
    return true;
  }

  yield* reportInactive(host, component, " after restart");
  return false;
}
