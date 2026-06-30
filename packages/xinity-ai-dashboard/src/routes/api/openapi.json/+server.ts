/**
 * Generates and serves OpenAPI JSON for the ORPC API surface.
 */
import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { text } from '@sveltejs/kit'
import { os, Procedure } from '@orpc/server'
import { router } from '$lib/server/orpc/router'
import { UserDto } from '$lib/orpc/dtos/user.dto'
import { ApiKeyDto } from '$lib/orpc/dtos/api-key.dto'

/** OpenAPI generator with Zod schema conversion. */
const generator = new OpenAPIGenerator({
  schemaConverters: [
    new ZodToJsonSchemaConverter()
  ],
});

/** Prefixes routes and removes internal procedures from public docs. */
const apiRouter = os.prefix("/api").router(removeInternalRecursively(router));
// @ts-ignore // type inaccuracy due to versions
const spec = await generator.generate(apiRouter, {
  info: {
    title: 'Xinity Orchestrator API',
    version: '0.1.0',
    description: `API interface of the Xinity LLM Orchestration Layer,
exposing endpoints regarding management of API keys, availability of LLM models,
and accessing information about recorded LLM calls`
  },
  tags: [
    { name: "User", description: "API Endpoints all around users. Currently this is only ever about the currently signed in user" },
    { name: "API Key", description: "All about API Keys to access llm apis with. API Keys also represent collections of actions as they are recorded. LLM usage is tracked by this key" },
    { name: "API Call", description: "Recorded API Calls" }
  ],
  commonSchemas: {
    UserDto: { schema: UserDto },
    ApiKeyDto: { schema: ApiKeyDto },
  },
})

/** Returns the generated OpenAPI JSON. */
export const GET = async () => {
  return text(JSON.stringify(spec), {
    headers: {
      "content-type": "application/json",
    }
  })
}

type Proc = Procedure<any, any, any, any, any, any>;
type RouterMap = { [k: string]: Proc | RouterMap };

function isProc(obj: Proc | RouterMap): obj is Proc {
  return Boolean(obj['~orpc']);
}

function isInternalProc(p: Proc): boolean {
  return Bun.env.NODE_ENV !== "development"
    && p['~orpc'].route.tags?.includes(".internal") === true;
}

/** Removes procedures tagged with `.internal` from the OpenAPI output. */
function removeInternalRecursively(router: RouterMap): RouterMap {
  const copy: RouterMap = {};
  for (const key in router) {
    const value = router[key];
    if (isProc(value)) {
      if (!isInternalProc(value)) copy[key] = value;
    } else {
      const filtered = removeInternalRecursively(value);
      if (Object.keys(filtered).length > 0) {
        copy[key] = filtered;
      }
    }
  }
  return copy;
}
