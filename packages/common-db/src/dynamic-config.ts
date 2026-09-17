import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dynamicConfigT } from "./schema/deployment-config";

export async function readDynamicConfig(db: PostgresJsDatabase): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: dynamicConfigT.key, value: dynamicConfigT.value })
    .from(dynamicConfigT);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
