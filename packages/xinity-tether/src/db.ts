import { preconfigureDB } from "common-db";
import { env } from "./env";
import { rootLogger } from "./logger";

export const { getDB, checkMigrations, subscribe, end } = preconfigureDB(env.DB_CONNECTION_URL, rootLogger);
