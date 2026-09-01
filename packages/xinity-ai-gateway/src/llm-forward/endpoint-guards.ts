import type { z } from "zod";
import { resolveModel, type ResolvedModel } from "./ai-sdk";
import { errorResponse, handleEndpointError, recordFailedRequest, validateModelType, validationError } from "./util";
import { checkAuth, type AuthResult } from "./auth";

/** Bun fills `params` in from the route pattern; it is absent on a directly constructed Request. */
export function pathParam(req: Request, name: string): string | undefined {
  return (req as Request & { params?: Record<string, string> }).params?.[name];
}

export type ResponseIdRouteContext = {
  auth: AuthResult;
  responseId: string;
  req: Request;
};

/**
 * Preamble for the `/v1/responses/:responseId` sub-routes, which authenticate and read a
 * path parameter but resolve no model, so `withEndpointGuards` does not fit them.
 */
export function withResponseIdRoute(
  methods: readonly string[],
  handler: (ctx: ResponseIdRouteContext) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!methods.includes(req.method)) {
      return errorResponse("Method not allowed", 405);
    }

    const auth = await checkAuth(req.headers.get("authorization") || "");
    if (auth instanceof Response) {
      return auth;
    }

    const responseId = pathParam(req, "responseId");
    if (!responseId) {
      return errorResponse("Not found", 404);
    }

    return handler({ auth, responseId, req });
  };
}

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
    const callStartTime = Date.now();
    let resolved: ResolvedModel | undefined;

    // Once a node was selected, any error response counts against it on the
    // Compute page. 499 (client disconnect) is not a backend failure.
    const noteFailedRequest = (res: Response): Response => {
      if (resolved && res.status >= 400 && res.status !== 499) {
        recordFailedRequest({ auth: resolved.auth, modelInfo: resolved.modelInfo, callStartTime });
      }
      return res;
    };

    try {
      if (opts.method && req.method !== opts.method) {
        return errorResponse("Method not allowed", 405);
      }

      const resolveResult = await resolveModel(req);
      if (resolveResult instanceof Response) {
        return resolveResult;
      }
      resolved = resolveResult;

      const typeError = validateModelType(resolved.modelInfo, opts.modelTypes);
      if (typeError) {
        return noteFailedRequest(typeError);
      }

      const parseResult = opts.bodySchema.safeParse(resolved.body);
      if (!parseResult.success) {
        return noteFailedRequest(validationError(parseResult.error));
      }

      return noteFailedRequest(await opts.handler({
        auth: resolved.auth,
        body: parseResult.data,
        rawBody: resolved.body,
        modelInfo: resolved.modelInfo,
        originalModel: resolved.originalModel,
        req,
      }));
    } catch (error) {
      return noteFailedRequest(handleEndpointError(error, opts.log));
    }
  };
}
