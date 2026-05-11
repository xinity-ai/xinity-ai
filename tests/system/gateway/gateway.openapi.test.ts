import { beforeAll, describe, expect, it } from "bun:test";
import { ensureGatewayRunning, gatewayUrl } from "./gateway-test-helpers";

type OpenApiSpec = {
  paths: Record<string, Record<string, { tags?: string[]; parameters?: Array<{ name: string; in: string }> }>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

beforeAll(async () => {
  await ensureGatewayRunning();
});

async function fetchSpec(): Promise<OpenApiSpec> {
  const res = await fetch(gatewayUrl("/openapi.json"));
  expect(res.status).toBe(200);
  return await res.json() as OpenApiSpec;
}

describe("xinity-ai-gateway openapi spec", () => {
  it("documents every OpenAI-compatible /v1/* route alongside oRPC routes", async () => {
    const spec = await fetchSpec();
    const paths = Object.keys(spec.paths);
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/models",
      "/v1/chat/completions",
      "/v1/completions",
      "/v1/embeddings",
      "/v1/rerank",
      "/v1/responses",
      "/v1/responses/{responseId}",
      "/healthCheck",
    ]));
  });

  it("documents the include_unavailable query parameter on /v1/models", async () => {
    const spec = await fetchSpec();
    const params = spec.paths["/v1/models"]?.get?.parameters ?? [];
    const includeUnavailable = params.find(p => p.name === "include_unavailable");
    expect(includeUnavailable).toBeDefined();
    expect(includeUnavailable?.in).toBe("query");
  });

  it("registers component schemas and the bearer security scheme", async () => {
    const spec = await fetchSpec();
    const schemas = spec.components?.schemas ?? {};
    expect(schemas.ModelObject).toBeDefined();
    expect(schemas.ChatCompletionRequest).toBeDefined();
    expect(schemas.EmbeddingRequest).toBeDefined();
    expect(schemas.RerankRequest).toBeDefined();
    expect(schemas.CreateResponseRequest).toBeDefined();

    const security = spec.components?.securitySchemes ?? {};
    expect(security.bearerAuth).toBeDefined();
  });
});
