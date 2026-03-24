import { preconfigureDB } from "common-db";
import { serverEnv } from "./serverenv";
import { rootLogger } from "./logging";

export const { getDB, checkMigrations, getMigrationState } = preconfigureDB(serverEnv.DB_CONNECTION_URL, rootLogger);
