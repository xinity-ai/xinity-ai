import { describe, expect, test } from "bun:test";
import { renderUpPlanScript, type UpPlan } from "../../src/lib/up-plan.ts";
import { buildPostgresProvisionCommands, describePostgresProvision, type PostgresProvision } from "../../src/lib/postgres-setup.ts";
import { describeRedisPlan, type RedisPlan } from "../../src/lib/redis-setup.ts";

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
    variant: "valkey",
    installCmd: "apt-get install -y valkey",
    startCmd: "systemctl start valkey",
    userIsSuper: false,
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
  test("lists install, start, and persist actions", () => {
    const lines = describeRedisPlan(provisionedRedis);
    expect(lines[0]).toContain("Provision valkey");
    expect(lines.some((l) => l.includes("apt-get install -y valkey"))).toBe(true);
    expect(lines.some((l) => l.includes("systemctl start valkey"))).toBe(true);
    expect(lines.some((l) => l.includes("store REDIS_URL"))).toBe(true);
  });

  test("nothing to do produces no lines", () => {
    expect(describeRedisPlan({ url: "redis://localhost:6379", persist: false })).toEqual([]);
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
    expect(script).toContain("apt-get install -y valkey");
    expect(script).toContain("printf '%s' 'redis://localhost:6379' > /etc/xinity-ai/secrets/REDIS_URL");
  });

  test("a keep-current redis plan is not part of an up-all script", async () => {
    const script = await renderUpPlanScript(planWith({}));
    expect(script).not.toContain("Redis");
  });
});
