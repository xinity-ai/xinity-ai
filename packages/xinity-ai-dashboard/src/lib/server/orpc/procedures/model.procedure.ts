import { rootOs, withOrganization, requirePermission } from "../root";
import z from "zod";
import { ModelV2Fields } from "xinity-infoserver";
import { catalogClient } from "$lib/server/model-catalog";

const ModelWithSpecifierSchema = ModelV2Fields.extend({
  publicSpecifier: z.string(),
  _source: z.string(),
});

const PaginatedModelsSchema = z.object({
  models: ModelWithSpecifierSchema.array(),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

/**
 * Deployments created before the per-engine format hold a specifier this catalog does
 * not know. They keep running and keep being scheduled; the way forward for one is to
 * point the deployment at a current entry, which the deployment form already allows.
 */
const listModels = rootOs
  .use(withOrganization)
  .use(requirePermission({ model: ["read"] }))
  .route({ path: "/", method: "GET", tags: ["Model"], summary: "List Models" })
  .input(z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    type: z.enum(["chat", "embedding", "rerank", "transcription"]).optional(),
    family: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }))
  .output(PaginatedModelsSchema)
  .handler(async ({ input }) => {
    const all = await catalogClient?.getAll() ?? [];
    const matching = all.filter(model =>
      (!input.type || model.type === input.type)
      && (!input.family || model.family === input.family)
      && (!input.tags?.length || input.tags.every(tag => model.tags.includes(tag as typeof model.tags[number]))),
    );

    const start = (input.page - 1) * input.pageSize;
    return {
      models: matching.slice(start, start + input.pageSize),
      total: matching.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  });

const getModel = rootOs
  .use(withOrganization)
  .use(requirePermission({ model: ["read"] }))
  .route({ path: "/{specifier}", method: "GET", tags: ["Model"], summary: "Get Model" })
  .input(z.object({ specifier: z.string() }))
  .output(ModelWithSpecifierSchema.nullable())
  .handler(async ({ input }) => {
    return await catalogClient?.get(input.specifier) ?? null;
  });

export const modelRouter = rootOs.prefix("/model").router({
  list: listModels,
  get: getModel,
});
