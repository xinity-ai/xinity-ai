import { router } from "../../rpc/router";
import { version } from "../../../../../package.json";
import scalar from "../../assets/scalar.html" with { type: "text" };

import {
  type ServerResponse,
} from "node:http";

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
      description: `The LLM Compute Node Server handles interactions between computers as part of a xinity-llm-enginge installation.
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

export async function createScalarPage(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(scalar);
}
