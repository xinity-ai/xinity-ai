import { preconfigureDB } from "common-db";
import { env } from "./env";
import { rootLogger } from "./logger";

export const { getDB, checkMigrations, listen } = preconfigureDB(env.DB_CONNECTION_URL, rootLogger);
