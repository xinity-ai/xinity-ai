import { z } from "zod";
import { ModelTypeEnum } from "common-env/model-catalog";

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const ModelListQuerySchema = PaginationSchema.extend({
  type: ModelTypeEnum.optional(),
  family: z.string().optional(),
  tag: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform(v => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
});
