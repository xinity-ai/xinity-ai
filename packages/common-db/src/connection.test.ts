import { describe, expect, it } from "bun:test";
import { checkMigrations } from "./connection";
import { expectedMigrationCount } from "./migrations";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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

  it("returns 'no_table' when migration table does not exist", async () => {
    const fakeDb = {
      execute: async () => {
        throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
      },
    } as unknown as PostgresJsDatabase;

    const result = await checkMigrations(fakeDb);
    expect(result).toEqual({ status: "no_table" });
  });

  it("returns 'error' with message when query fails unexpectedly", async () => {
    const fakeDb = {
      execute: async () => {
        throw new Error("connection timeout");
      },
    } as unknown as PostgresJsDatabase;

    const result = await checkMigrations(fakeDb);
    expect(result).toEqual({
      status: "error",
      message: "Error: connection timeout",
    });
  });
});
