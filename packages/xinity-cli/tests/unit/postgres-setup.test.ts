import { describe, expect, test } from "bun:test";
import {
  buildConnectionUrl, buildPostgresEnv, buildComposeFile,
  parsePostgresEnv, parsePublishedPort, inspectExistingPostgres,
} from "../../src/lib/postgres-setup.ts";
import { FakeHost } from "../helpers/fake-host.ts";

const ENV_PATH = "/etc/xinity-ai/infra/postgres/postgres.env";
const COMPOSE_PATH = "/etc/xinity-ai/infra/postgres/docker-compose.yml";

describe("buildConnectionUrl", () => {
  test("assembles a localhost URL from parts", () => {
    expect(buildConnectionUrl({ user: "xinity", password: "secret", db: "xinity", port: 5432 }))
      .toBe("postgresql://xinity:secret@localhost:5432/xinity");
  });

  test("url-encodes credentials with special characters", () => {
    const url = buildConnectionUrl({ user: "a@b", password: "p@ss/w:rd", db: "my db", port: 5433 });
    expect(url).toBe("postgresql://a%40b:p%40ss%2Fw%3Ard@localhost:5433/my%20db");
  });
});

describe("buildPostgresEnv", () => {
  test("writes the three POSTGRES_* keys the image reads on first boot", () => {
    const env = buildPostgresEnv({ db: "xinity", user: "xinity", password: "secret" });
    expect(env).toContain("POSTGRES_DB=xinity");
    expect(env).toContain("POSTGRES_USER=xinity");
    expect(env).toContain("POSTGRES_PASSWORD=secret");
  });
});

describe("buildComposeFile", () => {
  const envPath = "/etc/xinity-ai/infra/postgres/postgres.env";

  test("pins the postgres image and reads credentials from the env file", () => {
    const compose = buildComposeFile(5432, envPath);
    expect(compose).toContain("image: postgres:17.4-alpine");
    expect(compose).toContain("container_name: xinity-ai-postgres");
    expect(compose).toContain(`- ${envPath}`);
  });

  test("publishes the chosen port on localhost only", () => {
    expect(buildComposeFile(5433, envPath)).toContain('"127.0.0.1:5433:5432"');
  });

  test("persists data in a named volume, not the stack directory", () => {
    const compose = buildComposeFile(5432, envPath);
    expect(compose).toContain("xinity-postgres-data:/var/lib/postgresql/data");
    expect(compose).toContain("volumes:");
  });
});

describe("parsePostgresEnv", () => {
  test("round-trips the env file builder", () => {
    const env = buildPostgresEnv({ db: "xinity", user: "xinity", password: "s3cr3t" });
    expect(parsePostgresEnv(env)).toEqual({ db: "xinity", user: "xinity", password: "s3cr3t" });
  });

  test("ignores comments and blank lines, keeps '=' inside values", () => {
    const parsed = parsePostgresEnv("# header\n\nPOSTGRES_PASSWORD=a=b=c\nPOSTGRES_USER=u\n");
    expect(parsed.password).toBe("a=b=c");
    expect(parsed.user).toBe("u");
    expect(parsed.db).toBeUndefined();
  });
});

describe("parsePublishedPort", () => {
  test("recovers the published port from a compose file", () => {
    expect(parsePublishedPort(buildComposeFile(5544, ENV_PATH))).toBe(5544);
  });

  test("falls back when no published port is present", () => {
    expect(parsePublishedPort("services: {}", 5432)).toBe(5432);
  });
});

describe("inspectExistingPostgres", () => {
  test("reports a fully provisioned stack (volume + container + files)", async () => {
    const host = new FakeHost({
      run: (a) => {
        if (a[0] === "docker" && a[1] === "volume") return { ok: true };
        if (a[0] === "docker" && a[1] === "ps") return { ok: true, output: "xinity-ai-postgres" };
        return undefined;
      },
      files: { [ENV_PATH]: "POSTGRES_DB=xinity\n", [COMPOSE_PATH]: "services: {}\n" },
    });
    const existing = await inspectExistingPostgres(host);
    expect(existing.volumeExists).toBe(true);
    expect(existing.containerExists).toBe(true);
    expect(existing.envFile).toContain("POSTGRES_DB=xinity");
    expect(existing.composeFile).toContain("services");
  });

  test("reports a clean host (no volume, no container, no files)", async () => {
    const host = new FakeHost({ run: () => ({ ok: false }) });
    const existing = await inspectExistingPostgres(host);
    expect(existing.volumeExists).toBe(false);
    expect(existing.containerExists).toBe(false);
    expect(existing.envFile).toBeNull();
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
    const existing = await inspectExistingPostgres(host);
    expect(existing.volumeExists).toBe(true);
    expect(existing.containerExists).toBe(false);
  });
});
