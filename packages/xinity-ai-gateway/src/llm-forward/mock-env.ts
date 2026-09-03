import { resolveConfig } from "common-env";
import { gatewayConfig, type GatewayConfig } from "../config-schema";

const TEST_ENV = {
  DB_CONNECTION_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  INFOSERVER_URL: "http://localhost:3000",
  INFOSERVER_CACHE_TTL_MS: "30000",
  WEB_SEARCH_ENGINE_URL: "http://localhost:6148/",
  LOAD_BALANCE_STRATEGY: "random",
  LOG_LEVEL: "info",
  DEEP_RESEARCH_MAX_STEPS: "5",
  DEEP_RESEARCH_COMPACTION_THRESHOLD: "0.5",
};

// Derived from the declaration, so a field added there cannot go missing here and surface as an
// undefined deep inside an unrelated test.
export const MOCK_GATEWAY_CONFIG = resolveConfig<GatewayConfig>(gatewayConfig, { env: TEST_ENV }).value;
