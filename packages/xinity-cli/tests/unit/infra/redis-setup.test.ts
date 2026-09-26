import { describe, expect, test } from "bun:test";
import { buildRedisUrl, buildComposeFile, parseRequirePass } from "../../../src/lib/infra/redis-setup.ts";
import { randomToken } from "../../../src/lib/core/secrets.ts";

const PASSWORD = "tok3n-with_url-safe";

describe("buildRedisUrl", () => {
  test("puts the password in the empty-user position", () => {
    expect(buildRedisUrl(6379, PASSWORD)).toBe(`redis://:${PASSWORD}@localhost:6379`);
  });

  test("percent-encodes the password", () => {
    expect(buildRedisUrl(6379, "p@ss/w#rd")).toBe("redis://:p%40ss%2Fw%23rd@localhost:6379");
  });

  test("omits the credential when there is no password", () => {
    expect(buildRedisUrl(6380)).toBe("redis://localhost:6380");
  });
});

describe("buildComposeFile", () => {
  test("pins the redis image and requires the password", () => {
    const compose = buildComposeFile(6379, PASSWORD);
    expect(compose).toContain("image: redis:7-alpine");
    expect(compose).toContain("container_name: xinity-ai-redis");
    expect(compose).toContain(`"--requirepass", "${PASSWORD}"`);
  });

  test("gives redis-cli the password, so the healthcheck needs no flag", () => {
    const compose = buildComposeFile(6379, PASSWORD);
    expect(compose).toContain(`REDISCLI_AUTH: "${PASSWORD}"`);
    expect(compose).toContain('test: ["CMD", "redis-cli", "ping"]');
  });

  test("publishes the chosen port on localhost only", () => {
    expect(buildComposeFile(6380, PASSWORD)).toContain('"127.0.0.1:6380:6379"');
  });

  test("persists data in a named volume, not the stack directory", () => {
    const compose = buildComposeFile(6379, PASSWORD);
    expect(compose).toContain("xinity-redis-data:/data");
    expect(compose).toContain("volumes:");
  });
});

describe("parseRequirePass", () => {
  test("round-trips a generated password, so a re-run reuses it", () => {
    const generated = randomToken(32);
    expect(parseRequirePass(buildComposeFile(6379, generated))).toBe(generated);
  });

  test("is undefined for a stack without one", () => {
    const legacy = 'command: ["redis-server", "--appendonly", "yes"]';
    expect(parseRequirePass(legacy)).toBeUndefined();
  });
});
