import { describe, expect, test } from "bun:test";
import {
  buildSettings, buildComposeFile, buildSearxngCommands, type SearxngProvision,
} from "../../src/lib/searxng-setup.ts";
import type { ComposeCmd } from "../../src/lib/docker-stack.ts";

// Both files are built by string concatenation, so the only failure mode worth
// testing is a document SearXNG or Compose would reject or silently misread.
// Parsing the output catches that; substring matching cannot.

const CONFIG_DIR = "/etc/xinity-ai/infra/searxng/config";

function parseSettings(yml: string) {
  return Bun.YAML.parse(yml) as {
    server: { secret_key: string; port: number; bind_address: string };
    search: { formats: string[] };
  };
}

function parseCompose(yml: string) {
  return Bun.YAML.parse(yml) as {
    services: Record<string, { image: string; container_name: string; ports: string[]; volumes: string[] }>;
  };
}

describe("buildSettings", () => {
  test("enables the json format the gateway reads, alongside html", () => {
    expect(parseSettings(buildSettings("sekrit", 6148)).search.formats).toEqual(["html", "json"]);
  });

  test("carries the generated secret rather than the dev placeholder", () => {
    const settings = parseSettings(buildSettings("sekrit", 6148));
    expect(settings.server.secret_key).toBe("sekrit");
    expect(settings.server.secret_key).not.toContain("debug");
  });

  test("binds all interfaces inside the container, so Docker can reach it", () => {
    expect(parseSettings(buildSettings("sekrit", 6148)).server.bind_address).toBe("0.0.0.0");
  });
});

describe("buildComposeFile", () => {
  test("pins the image and publishes the chosen port on localhost only", () => {
    const searxng = parseCompose(buildComposeFile(6200, CONFIG_DIR)).services.searxng!;
    expect(searxng.image).toBe("searxng/searxng:2026.2.6-b5bb27f23");
    expect(searxng.container_name).toBe("xinity-ai-searxng");
    expect(searxng.ports).toEqual(["127.0.0.1:6200:8080"]);
  });

  test("mounts the config subdirectory, never the stack dir holding docker-compose.yml", () => {
    const searxng = parseCompose(buildComposeFile(6148, CONFIG_DIR)).services.searxng!;
    expect(searxng.volumes).toEqual([`${CONFIG_DIR}:/etc/searxng:rw`]);
    expect(searxng.volumes[0]).not.toBe("/etc/xinity-ai/infra/searxng:/etc/searxng:rw");
  });
});

describe("buildSearxngCommands", () => {
  const compose: ComposeCmd = { docker: "docker", sub: ["compose"] };

  test("new stack: writes both files before bringing the stack up", () => {
    const prov: SearxngProvision = {
      compose,
      port: 6148,
      url: "http://127.0.0.1:6148",
      files: { settings: "use_default_settings: true\n", composeFile: "services: {}\n" },
    };
    const cmds = buildSearxngCommands(prov);
    const settings = cmds.findIndex((c) => c.includes("settings.yml"));
    const composeFile = cmds.findIndex((c) => c.includes("docker-compose.yml") && c.startsWith("cat >"));
    const up = cmds.findIndex((c) => c.includes("up -d"));
    expect(cmds[0]).toBe(`mkdir -p ${CONFIG_DIR}`);
    expect(settings).toBeGreaterThan(0);
    expect(composeFile).toBeGreaterThan(0);
    expect(up).toBe(cmds.length - 1);
  });

  test("existing stack: only ensures the stack is running", () => {
    const prov: SearxngProvision = { compose, port: 6148, url: "http://127.0.0.1:6148" };
    expect(buildSearxngCommands(prov)).toEqual([
      "docker compose -f /etc/xinity-ai/infra/searxng/docker-compose.yml up -d",
    ]);
  });
});
