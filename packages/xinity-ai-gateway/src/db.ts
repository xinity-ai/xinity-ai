import { preconfigureDB } from "common-db";
import { config } from "./config";
import { rootLogger } from "./logger";

export const { getDB, checkMigrations, subscribe } = preconfigureDB(config.db.connectionUrl, rootLogger, { max: config.db.maxConnections });
