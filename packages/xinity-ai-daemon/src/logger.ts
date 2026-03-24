import { createLogger } from "common-log";
import { env } from "./env";

export const rootLogger = createLogger({
  level: env.LOG_LEVEL,
  service: "daemon",
  logDir: env.LOG_DIR,
});
