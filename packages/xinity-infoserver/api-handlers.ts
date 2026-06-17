import * as catalog from "./server-catalog";
import { resolveAllTags } from "./model-tags";
import { ModelListQuerySchema } from "./api-schemas";
import { z } from "zod";

function getRouteParam(req: Request, key: string): string | undefined {
  return (req as { params?: Record<string, string | undefined> }).params?.[key];
}

/**
 * GET /api/v1/models: paginated, filterable model list.
 */
export function handleModelList(req: Request): Response {
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams);
  const tags = url.searchParams.getAll("tag");
  const input = { ...raw, tag: tags.length > 0 ? tags : undefined };

  const parsed = ModelListQuerySchema.safeParse(input);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { page, pageSize, type, family, tag } = parsed.data;
  let models = catalog.getAll();

  if (type) models = models.filter(m => (m.type ?? "chat") === type);
  if (family) models = models.filter(m => (m.family ?? "unknown") === family);
  if (tag && tag.length > 0) {
    models = models.filter(m => {
      const modelTags = resolveAllTags(m);
      return tag.every(t => modelTags.includes(t));
    });
  }

  const total = models.length;
  const start = (page - 1) * pageSize;
  const paged = models.slice(start, start + pageSize);

  return Response.json({ models: paged, total, page, pageSize });
}

/**
 * GET /api/v1/models/family/:family: all models in a family.
 */
export function handleModelsByFamily(req: Request): Response {
  const family = getRouteParam(req, "family");
  if (!family) {
    return Response.json({ error: "Missing family parameter" }, { status: 400 });
  }
  const models = catalog.getByFamily(family);
  return Response.json(models);
}

/**
 * GET /api/v1/models/:specifier: resolve a model by its canonical specifier.
 */
export function handleModelBySpecifier(req: Request): Response {
  const specifier = getRouteParam(req, "specifier");
  if (!specifier) {
    return Response.json({ error: "Missing specifier parameter" }, { status: 400 });
  }
  const model = catalog.get(specifier);
  if (!model) {
    return Response.json({ error: "Model not found" }, { status: 404 });
  }
  return Response.json(model);
}

const BatchResolveSchema = z.object({
  specifiers: z.array(z.string()).min(1).max(200),
});

/**
 * POST /api/v1/models/resolve: batch resolve multiple specifiers at once.
 * Returns a map of specifier → model (or null if not found).
 */
export async function handleBatchResolve(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = BatchResolveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", details: parsed.error.issues },
      { status: 400 },
    );
  }

  return Response.json(catalog.resolveBatch(parsed.data.specifiers));
}
