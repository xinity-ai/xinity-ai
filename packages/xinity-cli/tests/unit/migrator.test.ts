import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Host } from "../../src/lib/host.ts";
import { describeMigrationStep, runMigrations } from "../../src/lib/migrator.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_IN_REPO = "packages/common-db/db-migration";

/** Reaching the host at all means source resolution did not stop where it should have. */
function unreachableHost(): Host {
  return {
    openTunnel: () => { throw new Error("openTunnel must not be called"); },
    withElevation: () => { throw new Error("withElevation must not be called"); },
    readFile: () => { throw new Error("readFile must not be called"); },
  } as unknown as Host;
}

describe("describeMigrationStep", () => {
  test("names the release for tagged targets", () => {
    expect(describeMigrationStep("v1.2.3", "postgresql://ops:hunter2@db.example:5432/xinity"))
      .toBe("Apply database migrations from release v1.2.3 to ops@db.example:5432/xinity");
  });

  test("names the repository path for local targets", () => {
    expect(describeMigrationStep("local:/srv/checkout", "postgresql://ops:hunter2@db.example/xinity"))
      .toBe("Apply database migrations from local repository /srv/checkout to ops@db.example/xinity");
  });

  test("never reveals the password", () => {
    const step = describeMigrationStep("local:.", "postgresql://ops:hunter2@db.example/xinity");
    expect(step).not.toContain("hunter2");
  });
});

describe("runMigrations with a local target", () => {
  test("fails with the resolved path when the directory has no migrations", async () => {
    const repoPath = join(REPO_ROOT, "packages/xinity-cli");
    const result = await runMigrations({
      connectionUrl: "postgresql://ops:hunter2@localhost/xinity",
      targetVersion: `local:${repoPath}`,
      dryRun: false,
      host: unreachableHost(),
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([`No migrations found at ${join(repoPath, MIGRATIONS_IN_REPO)}`]);
  });

  test("resolves the repository folder without contacting a release", async () => {
    const result = await runMigrations({
      connectionUrl: "postgresql://ops:hunter2@localhost/xinity",
      targetVersion: `local:${REPO_ROOT}`,
      dryRun: true,
      host: unreachableHost(),
    });

    expect(result).toEqual({ success: true, errors: [] });
  });

  test("the repository folder carries the layout drizzle's migrator expects", async () => {
    const journal = join(REPO_ROOT, MIGRATIONS_IN_REPO, "meta/_journal.json");
    expect(await Bun.file(journal).exists()).toBe(true);
  });
});
