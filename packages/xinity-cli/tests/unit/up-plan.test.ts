import { describe, expect, test } from "bun:test";
import { coreComponents, initialSharedSecrets, renderUpPlanScript, type UpPlan } from "../../src/lib/up-plan.ts";
import { buildPostgresProvisionCommands, describePostgresProvision, type PostgresProvision } from "../../src/lib/postgres-setup.ts";
import { describeRedisPlan, buildRedisProvisionCommands, type RedisPlan } from "../../src/lib/redis-setup.ts";

const COMPOSE = { docker: "docker", sub: ["compose"] } as const;

const newStackProvision: PostgresProvision = {
  compose: COMPOSE,
  user: "xinity",
  port: 5432,
  url: "postgresql://xinity:secret@localhost:5432/xinity",
  files: { envFile: "POSTGRES_DB=xinity\n", composeFile: "services:\n" },
};

const existingStackProvision: PostgresProvision = {
  compose: COMPOSE,
  user: "xinity",
  port: 5433,
  url: "postgresql://xinity:secret@localhost:5433/xinity",
};

const provisionedRedis: RedisPlan = {
  url: "redis://localhost:6379",
  persist: true,
  provision: {
    compose: COMPOSE,
    port: 6379,
    url: "redis://localhost:6379",
    composeFile: "services:\n",
  },
};

function planWith(overrides: Partial<UpPlan>): UpPlan {
  return { targetVersion: "v1.0.0", provisionOllama: false, components: [], ...overrides };
}

describe("buildPostgresProvisionCommands", () => {
  test("new stack: writes both files then starts the stack", () => {
    const cmds = buildPostgresProvisionCommands(newStackProvision);
    expect(cmds[0]).toContain("mkdir -p");
    expect(cmds.some((c) => c.includes("postgres.env") && c.includes("chmod 600"))).toBe(true);
    expect(cmds.some((c) => c.includes("docker-compose.yml"))).toBe(true);
    expect(cmds.at(-1)).toContain("up -d");
  });

  test("existing stack: only ensures the stack is running", () => {
    const cmds = buildPostgresProvisionCommands(existingStackProvision);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("up -d");
  });
});

describe("describePostgresProvision", () => {
  test("distinguishes creating from restarting", () => {
    expect(describePostgresProvision(newStackProvision)).toContain("Provision PostgreSQL");
    expect(describePostgresProvision(existingStackProvision)).toContain("existing PostgreSQL");
  });
});

describe("describeRedisPlan", () => {
  test("lists the provisioning and persist actions", () => {
    const lines = describeRedisPlan(provisionedRedis);
    expect(lines[0]).toContain("Provision Redis via Docker");
    expect(lines.some((l) => l.includes("store REDIS_URL"))).toBe(true);
  });

  test("nothing to do produces no lines", () => {
    expect(describeRedisPlan({ url: "redis://localhost:6379", persist: false })).toEqual([]);
  });
});

describe("buildRedisProvisionCommands", () => {
  test("new stack: writes the compose file then starts the stack", () => {
    const cmds = buildRedisProvisionCommands(provisionedRedis.provision!);
    expect(cmds[0]).toContain("mkdir -p");
    expect(cmds.some((c) => c.includes("docker-compose.yml"))).toBe(true);
    expect(cmds.at(-1)).toContain("up -d");
  });

  test("existing stack: only ensures the stack is running", () => {
    const cmds = buildRedisProvisionCommands({ compose: COMPOSE, port: 6380, url: "redis://localhost:6380" });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("up -d");
  });
});

describe("renderUpPlanScript", () => {
  test("includes provisioning commands, migration deferral, and the redis secret write", async () => {
    const script = await renderUpPlanScript(planWith({
      provisionPostgres: newStackProvision,
      migrations: { connectionUrl: newStackProvision.url, hint: "xinity@localhost:5432/xinity" },
      redis: provisionedRedis,
    }));
    expect(script).toContain("docker compose -f");
    expect(script).toContain("xinity up db --target-version v1.0.0");
    expect(script).toContain("/etc/xinity-ai/infra/redis/docker-compose.yml");
    expect(script).toContain("printf '%s' 'redis://localhost:6379' > /etc/xinity-ai/secrets/REDIS_URL");
  });

  test("a keep-current redis plan is not part of an up-all script", async () => {
    const script = await renderUpPlanScript(planWith({}));
    expect(script).not.toContain("Redis");
  });
});

describe("coreComponents", () => {
  test("always installs the tether, ordered before the daemon that depends on it", () => {
    const components = coreComponents({ installInfoserver: false, installDaemon: true });
    expect(components).toContain("tether");
    expect(components.indexOf("tether")).toBeLessThan(components.indexOf("daemon"));
  });

  test("the tether is not opt-in, unlike the infoserver and daemon", () => {
    expect(coreComponents({ installInfoserver: false, installDaemon: false }))
      .toEqual(["gateway", "dashboard", "tether"]);
    expect(coreComponents({ installInfoserver: true, installDaemon: false })[0]).toBe("infoserver");
  });
});

describe("initialSharedSecrets", () => {
  test("pre-fills the required secrets that carry no schema default", () => {
    const secrets = initialSharedSecrets();
    expect(secrets.BETTER_AUTH_SECRET).toBeTruthy();
    expect(secrets.TETHER_SECRET).toBeTruthy();
  });

  test("a distinct secret per run, and never a shared value between the two", () => {
    const first = initialSharedSecrets();
    const second = initialSharedSecrets();
    expect(first.BETTER_AUTH_SECRET).not.toBe(second.BETTER_AUTH_SECRET);
    expect(first.BETTER_AUTH_SECRET).not.toBe(first.TETHER_SECRET);
  });
});
