import { describe, expect, test } from "bun:test";
import {
  buildRedisUrl, buildComposeFile, parsePublishedPort, inspectExistingRedis,
} from "../../src/lib/redis-setup.ts";
import { FakeHost } from "../helpers/fake-host.ts";

const COMPOSE_PATH = "/etc/xinity-ai/infra/redis/docker-compose.yml";

describe("buildRedisUrl", () => {
  test("assembles an unauthenticated localhost URL", () => {
    expect(buildRedisUrl(6379)).toBe("redis://localhost:6379");
    expect(buildRedisUrl(6380)).toBe("redis://localhost:6380");
  });
});

describe("buildComposeFile", () => {
  test("pins the redis image and runs one unauthenticated instance", () => {
    const compose = buildComposeFile(6379);
    expect(compose).toContain("image: redis:7-alpine");
    expect(compose).toContain("container_name: xinity-ai-redis");
    expect(compose).not.toContain("requirepass");
    expect(compose).not.toContain("env_file");
  });

  test("publishes the chosen port on localhost only", () => {
    expect(buildComposeFile(6380)).toContain('"127.0.0.1:6380:6379"');
  });

  test("persists data in a named volume, not the stack directory", () => {
    const compose = buildComposeFile(6379);
    expect(compose).toContain("xinity-redis-data:/data");
    expect(compose).toContain("volumes:");
  });
});

describe("parsePublishedPort", () => {
  test("recovers the published port from a compose file", () => {
    expect(parsePublishedPort(buildComposeFile(6390))).toBe(6390);
  });

  test("falls back when no published port is present", () => {
    expect(parsePublishedPort("services: {}", 6379)).toBe(6379);
  });
});

describe("inspectExistingRedis", () => {
  test("reports a fully provisioned stack (volume + container + compose file)", async () => {
    const host = new FakeHost({
      run: (a) => {
        if (a[0] === "docker" && a[1] === "volume") return { ok: true };
        if (a[0] === "docker" && a[1] === "ps") return { ok: true, output: "xinity-ai-redis" };
        return undefined;
      },
      files: { [COMPOSE_PATH]: "services: {}\n" },
    });
    const existing = await inspectExistingRedis(host);
    expect(existing.volumeExists).toBe(true);
    expect(existing.containerExists).toBe(true);
    expect(existing.composeFile).toContain("services");
  });

  test("reports a clean host (no volume, no container, no compose file)", async () => {
    const host = new FakeHost({ run: () => ({ ok: false }) });
    const existing = await inspectExistingRedis(host);
    expect(existing.volumeExists).toBe(false);
    expect(existing.containerExists).toBe(false);
    expect(existing.composeFile).toBeNull();
  });

  test("treats an empty `docker ps` result as no container", async () => {
    const host = new FakeHost({
      run: (a) => {
        if (a[0] === "docker" && a[1] === "volume") return { ok: true };
        if (a[0] === "docker" && a[1] === "ps") return { ok: true, output: "" };
        return undefined;
      },
    });
    const existing = await inspectExistingRedis(host);
    expect(existing.volumeExists).toBe(true);
    expect(existing.containerExists).toBe(false);
  });
});
