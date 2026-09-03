import { parseEnv } from "common-env";
import { gatewayEnvSchema } from "../env-schema";

// Derived from the schema, so a variable added there cannot go missing here and surface as an
// undefined deep inside an unrelated test.
export const MOCK_GATEWAY_ENV = parseEnv(gatewayEnvSchema, {
  DB_CONNECTION_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  INFOSERVER_URL: "http://localhost:3000",
  INFOSERVER_CACHE_TTL_MS: "30000",
  WEB_SEARCH_ENGINE_URL: "http://localhost:6148/",
  LOAD_BALANCE_STRATEGY: "random",
  LOG_LEVEL: "info",
  DEEP_RESEARCH_MAX_STEPS: "5",
  DEEP_RESEARCH_COMPACTION_THRESHOLD: "0.5",
});
