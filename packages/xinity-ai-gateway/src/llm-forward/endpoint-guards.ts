import { z } from "zod";
import { resolveModel, type ResolvedModel } from "./ai-sdk";
import { errorResponse, handleEndpointError, validateModelType, validationError } from "./util";
import type { AuthResult } from "./auth";

type EndpointLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type EndpointHandlerContext<TBody> = {
  auth: AuthResult;
  body: TBody;
  rawBody: Record<string, unknown>;
  modelInfo: ResolvedModel["modelInfo"];
  originalModel: string;
  req: Request;
};

export type EndpointGuardOptions<TBody> = {
  modelTypes: string[];
  bodySchema: z.ZodType<TBody>;
  log: EndpointLogger;
  method?: "POST" | "GET";
  handler: (ctx: EndpointHandlerContext<TBody>) => Promise<Response>;
};

/**
 * Wraps an endpoint handler with the shared auth + model resolution + body
 * validation preamble and the standard error-catch tail. The wrapped handler
 * only sees a fully-parsed body and a resolved model.
 */
export function withEndpointGuards<TBody>(
  opts: EndpointGuardOptions<TBody>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      if (opts.method && req.method !== opts.method) {
        return errorResponse("Method not allowed", 405);
      }

      const resolved = await resolveModel(req);
      if (resolved instanceof Response) {
        return resolved;
      }

      const typeError = validateModelType(resolved.modelInfo, opts.modelTypes);
      if (typeError) {
        return typeError;
      }

      const parseResult = opts.bodySchema.safeParse(resolved.body);
      if (!parseResult.success) {
        return validationError(parseResult.error);
      }

      return await opts.handler({
        auth: resolved.auth,
        body: parseResult.data,
        rawBody: resolved.body,
        modelInfo: resolved.modelInfo,
        originalModel: resolved.originalModel,
        req,
      });
    } catch (error) {
      return handleEndpointError(error, opts.log);
    }
  };
}
