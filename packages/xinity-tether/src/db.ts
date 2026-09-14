import { preconfigureDB } from "common-db";
import { config } from "./config";
import { rootLogger } from "./logger";

export const { getDB, checkMigrations, subscribe, end } = preconfigureDB(config.db.connectionUrl, rootLogger);
