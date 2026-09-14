import { preconfigureDB } from "common-db";
import { config } from "./config";
import { rootLogger } from "./logging";

export const { getDB, checkMigrations, getMigrationState } = preconfigureDB(config.db.connectionUrl, rootLogger, { max: config.db.maxConnections });
