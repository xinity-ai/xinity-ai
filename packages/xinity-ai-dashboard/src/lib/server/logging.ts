import { createLogger } from "common-log";
import { config } from "./config";

/**
 * Root logger instance. Prefer `rootLogger.child({ name })` in modules.
 */
export const rootLogger = createLogger({
  level: config.log.level,
  service: "dashboard",
  logDir: config.log.dir,
});
