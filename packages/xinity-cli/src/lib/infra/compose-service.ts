/**
 * Lifecycle for CLI-managed Docker Compose stacks, layered on `docker-stack.ts`.
 *
 * The split is deliberate: `docker-stack.ts` holds probes and path helpers and
 * stays free of user-facing output, this module owns everything that prints. A
 * service module is then left with only its own policy, meaning its compose
 * file body, its prompts, and how it treats a stack that already exists.
 */
import { log, spinner as clackSpinner } from "../core/clack.ts";
import { cyan, dim } from "picocolors";
import { type Host, waitForReady } from "../core/host.ts";
import { pass, fail, warn } from "../core/output.ts";
import { heredoc } from "../up/service.ts";
import {
  resolveComposeCmd, composeArgs, composeName, stackDir,
  dockerDaemonReady, type ComposeCmd,
} from "./docker-stack.ts";

export type ComposeStack = {
  name: string;
  displayName: string;
  containerName: string;
  image: string;
  containerPort?: number;
  defaultPort: number;
  volumeName?: string;
}

export function stackPaths(stack: ComposeStack): { dir: string; composePath: string } {
  const dir = stackDir(stack.name);
  return { dir, composePath: `${dir}/docker-compose.yml` };
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export async function requireCompose(
  host: Host,
  stack: ComposeStack,
  opts: { requiredTo: string; fallbackHint: string },
): Promise<ComposeCmd | undefined> {
  const compose = await resolveComposeCmd(host);
  if (!compose) {
    warn("Docker", `Docker with Compose is required to ${opts.requiredTo}, and was not found.`);
    log.info(
      dim(`  This environment is not supported for CLI-managed ${stack.displayName}.\n`) +
      dim("  Install Docker (https://docs.docker.com/engine/install/) and re-run,\n") +
      dim(`  ${opts.fallbackHint}`),
    );
    return undefined;
  }
  if (compose.docker === "docker" && !(await dockerDaemonReady(host))) {
    warn("Docker", "The Docker CLI is installed but the daemon is not reachable.");
    log.info(
      dim("  Start Docker (e.g. `systemctl start docker`) or ensure your user can\n") +
      dim("  access the Docker socket (docker group), then re-run."),
    );
    return undefined;
  }
  pass("Docker", `Using ${cyan(composeName(compose))}`);
  return compose;
}

// ─── Pre-existing state ──────────────────────────────────────────────────────

export type ExistingStack = {
  volumeExists: boolean;
  containerExists: boolean;
  composeFile: string | null;
}

export async function inspectStack(host: Host, stack: ComposeStack): Promise<ExistingStack> {
  const volume = stack.volumeName
    ? await host.run(["docker", "volume", "inspect", stack.volumeName])
    : undefined;
  const container = await host.run([
    "docker", "ps", "-a", "--filter", `name=${stack.containerName}`, "--format", "{{.Names}}",
  ]);
  return {
    volumeExists: volume?.ok ?? false,
    containerExists: container.ok && container.output.trim().length > 0,
    composeFile: await host.readFile(stackPaths(stack).composePath),
  };
}

export function parsePublishedPort(composeContent: string, stack: ComposeStack): number {
  if (stack.containerPort === undefined) {
    return stack.defaultPort;
  }
  const match = composeContent.match(new RegExp(`127\\.0\\.0\\.1:(\\d+):${stack.containerPort}`));
  return match ? Number(match[1]) : stack.defaultPort;
}

// ─── File writing ────────────────────────────────────────────────────────────

export function buildWriteFileCommand(
  stack: ComposeStack,
  path: string,
  content: string,
  mode?: string,
): string {
  const chmod = mode ? `\nchmod ${mode} ${path}` : "";
  const tag = `XINITY_${stack.name.toUpperCase()}_EOF`;
  return `cat > ${path} ${heredoc(tag, content)}${chmod}`;
}

export async function writeStackFile(
  host: Host,
  stack: ComposeStack,
  path: string,
  content: string,
  label: string,
  mode?: string,
): Promise<boolean> {
  const result = await host.withElevation(
    buildWriteFileCommand(stack, path, content, mode),
    `Write ${label}`,
  );
  if (!result.success) {
    fail("Config", `Failed to write ${label}`);
    return false;
  }
  return true;
}

// ─── Start and health ────────────────────────────────────────────────────────

const READY_TIMEOUT_SECONDS = 30;

export function composeUpCommand(compose: ComposeCmd, stack: ComposeStack): string {
  return composeArgs(compose, stackPaths(stack).composePath, "up", "-d").join(" ");
}

export function composeBaseCommand(compose: ComposeCmd, stack: ComposeStack): string {
  return composeArgs(compose, stackPaths(stack).composePath).join(" ");
}

export function execCommand(compose: ComposeCmd, stack: ComposeStack, ...command: string[]): string {
  return composeArgs(compose, stackPaths(stack).composePath, "exec", "-T", stack.name, ...command).join(" ");
}

export async function startStack(
  host: Host,
  compose: ComposeCmd,
  stack: ComposeStack,
  opts: { reachableAt: string; ready: () => Promise<boolean> },
): Promise<boolean> {
  const up = await host.withElevation(
    composeUpCommand(compose, stack),
    `Start ${stack.displayName} container`,
  );
  if (!up.success) {
    fail("Start", `Failed to start the ${stack.displayName} container`);
    return false;
  }

  const spinner = clackSpinner();
  spinner.start(`Waiting for ${stack.displayName} to become ready…`);
  if (!(await waitForReady(opts.ready))) {
    spinner.stop("Timed out");
    fail("Health", `${stack.displayName} container did not become ready within ${READY_TIMEOUT_SECONDS} seconds`);
    return false;
  }
  spinner.stop(`${stack.displayName} is ready`);
  pass("Health", `${stack.displayName} reachable at ${opts.reachableAt}`);
  return true;
}
