import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDependencyProbe, type DependencyProbe, type PinoLike } from "common-env";

export function createDatabaseProbe(
  getDB: () => PostgresJsDatabase,
  log: PinoLike,
  onUnreachable?: () => void,
): DependencyProbe {
  return createDependencyProbe({ name: "Database", ping: () => getDB().execute(sql`SELECT 1`), log, onUnreachable });
}
