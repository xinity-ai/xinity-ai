import { createLogger } from "common-log";
import { serverEnv } from "./serverenv";

/**
 * Root logger instance. Prefer `rootLogger.child({ name })` in modules.
 */
export const rootLogger = createLogger({
  level: serverEnv.LOG_LEVEL,
  service: "dashboard",
  logDir: serverEnv.LOG_DIR,
});
