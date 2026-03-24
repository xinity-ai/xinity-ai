import { preconfigureDB } from "common-db";
import { env } from "../env";
import { rootLogger } from "../logger";

if (!env.DB_CONNECTION_URL) {
  throw new Error("MISSING: env.DB_CONNECTION_URL");
}

export const {
  getDB,
  listen,
  checkMigrations,
} = preconfigureDB(env.DB_CONNECTION_URL, rootLogger);