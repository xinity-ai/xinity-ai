
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "src/schema",
  out: "db-migration",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DB_CONNECTION_URL!,
  },
});
