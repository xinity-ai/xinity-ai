import { router } from "../../rpc/router";
import { version } from "../../../../../package.json";
import scalar from "../../assets/scalar.html" with { type: "text" };

export async function createOpenapiSpec() {
  const { OpenAPIGenerator } = await import("@orpc/openapi");
  const { ZodToJsonSchemaConverter } = await import("@orpc/zod/zod4");
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const spec = await generator.generate(router, {
    info: {
      title: "LLM Compute Node Server",
      version,
      description: `The LLM Compute Node Server handles interactions between computers as part of a xinity-llm-engine installation.
    Authentication is handled via API key in the \`x-apikey\` header.`,
    },
    security: [{ apiKeyAuth: [] }],
    tags: [],
    commonSchemas: {
      // ChatRequestDto: { schema: ChatRequestDto },
    },
    components: {
      securitySchemes: {
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-apikey",
        },
      },
    },
  });
  return spec;
}

export function createScalarPage() {
  return new Response(scalar as unknown as string, { headers: { "Content-Type": "text/html" } });
}
