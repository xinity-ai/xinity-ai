import { z } from "zod";
import { defineGroup, env, type GroupDef } from "common-env";

export type LoggingConfig = {
  level: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  dir?: string;
};

export function loggingGroup(): GroupDef<LoggingConfig> {
  return defineGroup<LoggingConfig>({
    id: "log",
    title: "Logging",
    expert: true,
    fields: {
      level: env("LOG_LEVEL", z.enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("debug").describe("Log level")),
      dir: env("LOG_DIR", z.string().optional().describe("Log file directory (enables file logging)")),
    },
  });
}
