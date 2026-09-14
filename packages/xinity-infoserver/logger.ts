import { createLogger } from "common-log";
import { config } from "./config";

export const rootLogger = createLogger({
  level: config.log.level,
  service: "infoserver",
  logDir: config.log.dir,
});
