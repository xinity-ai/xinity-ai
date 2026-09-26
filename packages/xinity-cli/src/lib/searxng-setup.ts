/**
 * `xinity up infra-searxng`. Docker only, by the same rule as PostgreSQL.
 *
 * The gateway's web-search tool fetches `<url>/search?q=...&format=json`, so
 * the json output format is not optional: SearXNG ships html-only, and an
 * instance without json answers every liveness check while failing every
 * search. That is why setup verifies the format rather than just the port.
 */
import { log, note, text } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";
import type { Host } from "./host.ts";
import { pass, info, warn, promptOrUndefined } from "./output.ts";
import { tcpPortInUse, type ComposeCmd } from "./docker-stack.ts";
import {
  type ComposeStack,
  stackPaths, requireCompose, inspectStack, parsePublishedPort,
  buildWriteFileCommand, writeStackFile, startStack, composeUpCommand,
  composeBaseCommand,
} from "./compose-service.ts";
import { randomToken } from "./secrets.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

// Image pinned to match the dev compose.yaml and deployment template.
const SEARXNG: ComposeStack = {
  name: "searxng",
  displayName: "SearXNG",
  containerName: "xinity-ai-searxng",
  image: "searxng/searxng:2026.2.6-b5bb27f23",
  containerPort: 8080,
  defaultPort: 6148,
};

const { dir: STACK_DIR, composePath: COMPOSE_PATH } = stackPaths(SEARXNG);
// Its own directory: the container is handed this whole path, and it has no
// business seeing docker-compose.yml.
const CONFIG_DIR = `${STACK_DIR}/config`;
const SETTINGS_PATH = `${CONFIG_DIR}/settings.yml`;

function endpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// ─── Config generation ───────────────────────────────────────────────────────

export function buildSettings(secretKey: string, port: number): string {
  return [
    "# Managed by `xinity up infra-searxng`. Edit and run `docker compose restart`.",
    "#",
    "# The json format is what the gateway's web-search tool reads. Removing it",
    "# leaves a healthy-looking instance that fails every search.",
    "use_default_settings: true",
    "server:",
    `  secret_key: "${secretKey}"`,
    `  port: ${port}`,
    '  bind_address: "0.0.0.0"',
    "search:",
    "  formats:",
    "    - html",
    "    - json",
    "ui:",
    "  static_use_hash: true",
    "enabled_plugins:",
    "  - 'Hash plugin'",
    "  - 'Self Information'",
    "  - 'Tracker avoidance'",
    "",
  ].join("\n");
}

export function buildComposeFile(port: number, configDir: string): string {
  return [
    "# Managed by `xinity up infra-searxng`. This stack is yours: edit",
    "# config/settings.yml and run `docker compose restart`, or",
    "# `docker compose down` to remove it. Recreate it any time with the CLI.",
    "#",
    "# The port is published on 127.0.0.1 only, so the instance is reachable at",
    "# localhost but not exposed to the network.",
    "services:",
    `  ${SEARXNG.name}:`,
    `    image: ${SEARXNG.image}`,
    `    container_name: ${SEARXNG.containerName}`,
    "    restart: unless-stopped",
    "    ports:",
    `      - "127.0.0.1:${port}:${SEARXNG.containerPort}"`,
    "    volumes:",
    `      - ${configDir}:/etc/searxng:rw`,
    "",
  ].join("\n");
}

// ─── Provision via Docker ────────────────────────────────────────────────────

export type SearxngProvision = {
  compose: ComposeCmd;
  port: number;
  url: string;
  files?: { settings: string; composeFile: string };
}

export async function planSearxng(host: Host): Promise<SearxngProvision | undefined> {
  const compose = await requireCompose(host, SEARXNG, {
    requiredTo: "run a SearXNG instance",
    fallbackHint: "or run SearXNG yourself and point the gateway at it via WEB_SEARCH_CREDENTIAL.",
  });
  if (!compose) return undefined;

  const existing = await inspectStack(host, SEARXNG);
  if (existing.composeFile) {
    const port = parsePublishedPort(existing.composeFile, SEARXNG);
    info("SearXNG", `Reusing the existing stack in ${STACK_DIR}.`);
    return { compose, port, url: endpoint(port) };
  }

  log.step(bold("Configure SearXNG"));

  const portStr = await promptOrUndefined(text({
    message: "Port to publish on localhost",
    placeholder: String(SEARXNG.defaultPort),
    defaultValue: String(SEARXNG.defaultPort),
  }));
  if (portStr === undefined) return undefined;
  const port = Number(portStr) || SEARXNG.defaultPort;

  // Best-effort, non-fatal: a clash is most often a SearXNG the user could
  // instead point the gateway at directly.
  if (await tcpPortInUse(host, port)) {
    warn("Port", `Something is already listening on localhost:${port}. Starting the container will fail if it is still bound.`);
  }

  return {
    compose,
    port,
    url: endpoint(port),
    files: {
      settings: buildSettings(randomToken(32), port),
      composeFile: buildComposeFile(port, CONFIG_DIR),
    },
  };
}

export function buildSearxngCommands(prov: SearxngProvision): string[] {
  const up = composeUpCommand(prov.compose, SEARXNG);
  if (!prov.files) return [up];
  return [
    `mkdir -p ${CONFIG_DIR}`,
    buildWriteFileCommand(SEARXNG, SETTINGS_PATH, prov.files.settings),
    buildWriteFileCommand(SEARXNG, COMPOSE_PATH, prov.files.composeFile),
    up,
  ];
}

async function verifyJsonFormat(host: Host, url: string): Promise<void> {
  const res = await host.run(["curl", "-sf", `${url}/search?q=xinity&format=json`]);
  if (res.ok) {
    pass("Search", "The json format the gateway needs is enabled");
    return;
  }
  warn("Search", `${url} answered, but /search?format=json did not.`);
  log.info(
    dim(`  The gateway's web search will fail until json is enabled.\n`) +
    dim(`  Check the 'search.formats' list in ${SETTINGS_PATH}.`),
  );
}

function reportSuccess(prov: SearxngProvision): void {
  const manageCmd = composeBaseCommand(prov.compose, SEARXNG);
  note(
    [`WEB_SEARCH_PROVIDER=searxng`, `WEB_SEARCH_CREDENTIAL=${prov.url}`].join("\n"),
    "Set these on the gateway, in its env file or under instance settings",
  );
  log.info(
    `This stack is yours to manage. Files live in ${STACK_DIR}:\n` +
    `  ${cyan(`${manageCmd} restart`)}   (after editing ${SETTINGS_PATH})\n` +
    `  ${cyan(`${manageCmd} down`)}      (stop and remove the container)`,
  );
}

export async function applySearxng(prov: SearxngProvision, host: Host): Promise<boolean> {
  if (prov.files) {
    await host.withElevation(`mkdir -p ${CONFIG_DIR}`, "Create stack directory");
    if (!(await writeStackFile(host, SEARXNG, SETTINGS_PATH, prov.files.settings, "SearXNG settings"))) return false;
    if (!(await writeStackFile(host, SEARXNG, COMPOSE_PATH, prov.files.composeFile, "compose file"))) return false;
    pass("Config", `Wrote ${SETTINGS_PATH} and ${COMPOSE_PATH}`);
  }

  const started = await startStack(host, prov.compose, SEARXNG, {
    reachableAt: prov.url,
    ready: async () => (await host.run(["curl", "-sf", "-o", "/dev/null", `${prov.url}/`])).ok,
  });
  if (!started) return false;

  await verifyJsonFormat(host, prov.url);
  reportSuccess(prov);
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function searxngSetup(host: Host, dryRun: boolean): Promise<string | undefined> {
  log.step(bold("SearXNG web search setup"));
  log.info(
    "SearXNG is a self-hosted metasearch engine. The gateway queries it for\n" +
    "web-search-augmented generation and deep research.",
  );

  const prov = await planSearxng(host);
  if (!prov) return undefined;

  if (dryRun) {
    for (const cmd of buildSearxngCommands(prov)) {
      info("Dry run", `Would run: ${dim(cmd.split("\n")[0] ?? cmd)}`);
    }
    note(`WEB_SEARCH_CREDENTIAL=${prov.url}`, prov.files ? "Instance URL (not yet created)" : "Existing instance URL");
    return prov.url;
  }

  return (await applySearxng(prov, host)) ? prov.url : undefined;
}
