/**
 * Shared helpers for CLI-managed Docker Compose stacks (Postgres, Prometheus, …).
 *
 * These are infrastructure components the CLI *sets up* but does not *manage*:
 * it writes a small, hand-editable compose stack to a fixed, documented location
 * and then leaves the user fully in control via plain `docker compose` commands.
 *
 * Location rationale: the stacks live under a system path (not a home directory)
 * because Docker access is not assumed to be rootless/group-based, so the stacks
 * are operated with elevation. `infra/` mirrors the `infra-<name>` command
 * namespace, so `infra-postgres` maps to `${INFRA_DIR}/postgres`.
 */
import { type Host, commandExistsOn } from "./host.ts";

/** Parent directory for CLI-managed Docker stacks. One subdirectory per `infra-<name>`. */
export const INFRA_DIR = "/etc/xinity-ai/infra";

/** Absolute directory for a named stack, e.g. stackDir("postgres") -> /etc/xinity-ai/infra/postgres. */
export function stackDir(name: string): string {
  return `${INFRA_DIR}/${name}`;
}

export type ComposeCmd =
  | { docker: "docker"; sub: ["compose"] }
  | { docker: "docker-compose"; sub: [] };

/**
 * Resolve which compose CLI is available: the modern `docker compose` plugin or
 * the legacy `docker-compose` binary. Returns null when neither works, which the
 * callers treat as "this environment is unsupported for CLI-managed stacks".
 */
export async function resolveComposeCmd(host: Host): Promise<ComposeCmd | null> {
  if (await commandExistsOn(host, "docker")) {
    const v2 = await host.run(["docker", "compose", "version"]);
    if (v2.ok) return { docker: "docker", sub: ["compose"] };
  }
  if (await commandExistsOn(host, "docker-compose")) {
    return { docker: "docker-compose", sub: [] };
  }
  return null;
}

export function composeName(cmd: ComposeCmd): string {
  return [cmd.docker, ...cmd.sub].join(" ");
}

/** Build a compose invocation bound to a specific compose file. */
export function composeArgs(cmd: ComposeCmd, composePath: string, ...rest: string[]): string[] {
  return [cmd.docker, ...cmd.sub, "-f", composePath, ...rest];
}

/**
 * Whether the Docker daemon is reachable, not merely installed: `docker compose
 * version` succeeds without a running daemon, so this distinguishes "not installed"
 * from "daemon down / no socket access". Probes the `docker` CLI only.
 */
export async function dockerDaemonReady(host: Host): Promise<boolean> {
  return (await host.run(["docker", "info"])).ok;
}

/**
 * Best-effort check for whether a TCP port is already listening on the host.
 * Tries `ss`, then `lsof`. If neither tool is available we cannot tell, so we
 * return false rather than block setup on a guess. Callers should treat a true
 * result as a warning, not a hard failure.
 */
export async function tcpPortInUse(host: Host, port: number): Promise<boolean> {
  const ss = await host.run(["ss", "-Hltn", `sport = :${port}`]);
  if (ss.ok && ss.output.trim().length > 0) return true;

  const lsof = await host.run(["lsof", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsof.ok && lsof.output.trim().length > 0) return true;

  return false;
}
