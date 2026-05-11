import { z } from "zod";
import { secret, expert } from "common-env";
import { logEnvSchema } from "common-log";

export const conductorEnvSchema = z.object({
  HOST: z.string().default("localhost").describe("Bind address (use 0.0.0.0 to listen on all interfaces)"),
  PORT: z.coerce.number().default(4020).describe("Listen port"),
  UNIX_SOCKET: z.string().optional().describe("Unix socket path (overrides HOST/PORT when set)").meta(expert()),
  DB_CONNECTION_URL: z.url().describe("PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname)").meta(secret()),
}).extend(logEnvSchema.shape);
