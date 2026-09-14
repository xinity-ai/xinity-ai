import { createLogger } from "common-log";
import { config } from "./config";

export const rootLogger = createLogger({
  level: config.log.level,
  service: "tether",
  logDir: config.log.dir,
});
