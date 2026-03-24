import { createLogger } from "common-log";
import { env } from "./env";

export const rootLogger = createLogger({
  level: env.LOG_LEVEL,
  service: "infoserver",
  logDir: env.LOG_DIR,
});
