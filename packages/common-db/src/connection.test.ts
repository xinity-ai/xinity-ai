import { describe, expect, it } from "bun:test";
import { checkMigrations, preconfigureDB } from "./connection";
import { expectedMigrationCount } from "./migrations";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failingDb(err: unknown): PostgresJsDatabase {
  return {
    execute: async () => {
      throw err;
    },
  } as unknown as PostgresJsDatabase;
}

describe("checkMigrations", () => {
  it("returns 'ok' when applied count equals or exceeds expected count", async () => {
    const fakeDb = {
      execute: async () => [{ count: expectedMigrationCount }],
    } as unknown as PostgresJsDatabase;

    const result = await checkMigrations(fakeDb);
    expect(result).toEqual({ status: "ok" });
  });

  it("returns 'pending' with applied and expected counts when fewer migrations are applied", async () => {
    const fakeDb = {
      execute: async () => [{ count: 0 }],
    } as unknown as PostgresJsDatabase;

    const result = await checkMigrations(fakeDb);
    expect(result).toEqual({
      status: "pending",
      applied: 0,
      expected: expectedMigrationCount,
    });
  });

  it("returns 'no_table' when the migrations table is missing", async () => {
    const cause = pgError("42P01", 'relation "drizzle.__drizzle_migrations" does not exist');
    const result = await checkMigrations(failingDb(new Error("Failed query", { cause })));
    expect(result).toEqual({ status: "no_table" });
  });

  it("returns 'unreachable' when Postgres is still starting up", async () => {
    const cause = pgError("57P03", "the database system is not yet accepting connections");
    const result = await checkMigrations(failingDb(new Error("Failed query", { cause })));
    expect(result.status).toBe("unreachable");
  });

  it("returns 'unreachable' for a socket failure that never reached Postgres", async () => {
    const result = await checkMigrations(failingDb(pgError("ECONNREFUSED", "connect ECONNREFUSED")));
    expect(result.status).toBe("unreachable");
  });

  it("does not mistake a missing database for a missing migrations table", async () => {
    const cause = pgError("3D000", 'database "xinity" does not exist');
    const result = await checkMigrations(failingDb(new Error("Failed query", { cause })));
    expect(result.status).toBe("error");
  });

  it("returns 'error' with message when the query fails without a driver code", async () => {
    const result = await checkMigrations(failingDb(new Error("something unexpected")));
    expect(result).toEqual({
      status: "error",
      message: "Error: something unexpected",
    });
  });
});

describe("preconfigureDB", () => {
  it("initializes without connecting and exports checkMigrations / getDB", () => {
    const { checkMigrations: cm, getDB, getMigrationState } = preconfigureDB("postgresql://localhost:5432/test");
    expect(typeof cm).toBe("function");
    expect(typeof getDB).toBe("function");
    expect(getMigrationState()).toBeNull();
  });
});

