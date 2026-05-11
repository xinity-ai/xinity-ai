import { version } from "../../../package.json";
import scalar from "./assets/scalar.html" with { type: "text" };
import { serverRouter } from "./rpc/gatewayRouter";
import {
  openaiCompatPaths,
  openaiCompatSchemas,
  openaiCompatSecuritySchemes,
  openaiCompatTags,
} from "./openai-compat-openapi";

export async function createOpenapiSpec() {
  const { OpenAPIGenerator } = await import("@orpc/openapi");
  const { ZodToJsonSchemaConverter } = await import("@orpc/zod/zod4");
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const spec = await generator.generate(serverRouter, {
    info: {
      title: "Xinity AI Gateway",
      version,
      description: `The gateway represents one of the central pieces of xinity infrastructure. It
      - forwards calls to the respective target nodes running models
      - records usage and api call contents / messages
      - provides metrics about model usage, for observability

      OpenAI-compatible endpoints are listed below under the "OpenAI Compatible" tag.
      Point the baseUrl of an OpenAI client toward /v1 to use them.
      `,
    },
    tags: openaiCompatTags,
    paths: openaiCompatPaths,
    components: {
      schemas: openaiCompatSchemas,
      securitySchemes: openaiCompatSecuritySchemes,
    },
  });
  return new Response(JSON.stringify(spec), {
    headers: { "content-type": "application/json" },
    status: 200,
  })
}

export function createScalarPage() {
  return new Response(scalar.toString(), {
    headers: { "Content-Type": "text/html" },
    status: 200,
  })
}
