import { preconfigureDB } from "common-db";
import { env } from "../env";
import { rootLogger } from "../logger";

export const {
  getDB,
  listen,
  checkMigrations,
} = preconfigureDB(env.DB_CONNECTION_URL, rootLogger);