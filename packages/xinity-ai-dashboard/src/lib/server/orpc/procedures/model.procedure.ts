import { rootOs, withAuth } from "../root";
import z from "zod";
import { ModelSchema } from "xinity-infoserver";
import { infoClient } from "$lib/server/info-client";

const ModelWithSpecifierSchema = ModelSchema.extend({
  publicSpecifier: z.string(),
  _source: z.string(),
});

const PaginatedModelsSchema = z.object({
  models: ModelWithSpecifierSchema.array(),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const listModels = rootOs
  .use(withAuth)
  .route({ path: "/", method: "GET", tags: ["Model"], summary: "List Models" })
  .input(z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    type: z.enum(["chat", "embedding", "rerank"]).optional(),
    family: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }))
  .output(PaginatedModelsSchema)
  .handler(async ({ input }) => {
    return await infoClient?.fetchModels(input) ?? { models: [], total: 0, page: input.page, pageSize: input.pageSize };
  });

const getModel = rootOs
  .use(withAuth)
  .route({ path: "/:specifier", method: "GET", tags: ["Model"], summary: "Get Model" })
  .input(z.object({ specifier: z.string() }))
  .output(ModelWithSpecifierSchema.nullable())
  .handler(async ({ input }) => {
    return await infoClient?.fetchModel({ kind: "canonical", specifier: input.specifier }) ?? null;
  });

export const modelRouter = rootOs.prefix("/model").router({ 
  list: listModels, 
  get: getModel,
});
