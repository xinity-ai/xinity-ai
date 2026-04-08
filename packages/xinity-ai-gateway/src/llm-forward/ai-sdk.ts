import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { checkAuth } from "./auth";
import type { AuthResult } from "./auth";
import { getModelInfo } from "./model-data";
import { errorResponse } from "./util";
import { resolveApplicationByName } from "./application-resolver";
import { releaseCallbacks } from "./release-registry";
import { backendUrl, hasCustomCa, backendFetch } from "./backend-fetch";
import { isDeepResearchRequest, stripDeepResearchSuffix } from "./deep-research/detect";

export type ResolvedModel = {
  auth: AuthResult;
  body: Record<string, unknown>;
  originalModel: string;
  /** The model name used for resolution (suffix stripped if deep research). */
  baseModelName: string;
  /** Whether the request targets deep research mode. */
  deepResearch: boolean;
  modelInfo: NonNullable<Awaited<ReturnType<typeof getModelInfo>>>;
};

export type AuthorizedModelContext = ResolvedModel & {
  provider: OpenAICompatibleProvider;
};

export async function resolveModel(
  req: Request
): Promise<Response | ResolvedModel> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) {
    return authCheckResponse;
  }

  // Resolve application: X-Application header overrides key's default
  const xAppHeader = req.headers.get("x-application");
  let resolvedApplicationId = authCheckResponse.applicationId;

  if (xAppHeader) {
    const appId = await resolveApplicationByName(xAppHeader, authCheckResponse.orgId);
    if (!appId) {
      return errorResponse(`Application "${xAppHeader}" not found`, 404);
    }
    resolvedApplicationId = appId;
  }

  const auth: AuthResult = {
    ...authCheckResponse,
    applicationId: resolvedApplicationId,
  };

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return errorResponse("Unsupported data type", 422);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const originalModel = body.model;
  if (typeof originalModel !== "string" || originalModel.length === 0) {
    return errorResponse("Missing or invalid 'model' field", 400);
  }

  const deepResearch = isDeepResearchRequest(originalModel);
  const baseModelName = deepResearch ? stripDeepResearchSuffix(originalModel) : originalModel;

  const modelInfo = await getModelInfo(auth.orgId, baseModelName, auth.keyId);
  if (!modelInfo) {
    return errorResponse("Model not found", 404);
  }

  releaseCallbacks.set(req, modelInfo.release);

  return {
    auth,
    body,
    originalModel,
    baseModelName,
    deepResearch,
    modelInfo,
  };
}

export async function resolveAuthorizedModel(
  req: Request
): Promise<Response | AuthorizedModelContext> {
  const resolved = await resolveModel(req);
  if (resolved instanceof Response) return resolved;

  const provider = createOpenAICompatible({
    name: resolved.modelInfo.driver,
    baseURL: backendUrl(resolved.modelInfo.host, resolved.modelInfo.model, "/v1", resolved.modelInfo.tls),
    apiKey: resolved.modelInfo.authToken ?? "none",
    includeUsage: true,
    supportsStructuredOutputs: resolved.modelInfo.driver === "vllm",
    ...(hasCustomCa ? { fetch: backendFetch as typeof globalThis.fetch } : {}),
  });

  return { ...resolved, provider };
}
