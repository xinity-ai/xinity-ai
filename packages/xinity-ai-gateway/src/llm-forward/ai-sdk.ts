import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { checkAuth } from "./auth";
import type { AuthResult } from "./auth";
import { getModelInfo } from "./model-data";
import { errorResponse } from "./util";
import { resolveApplicationByName } from "./application-resolver";
import { releaseCallbacks } from "./release-registry";
import { backendUrl, hasCustomCa, backendFetch } from "./backend-fetch";

export type ResolvedModel = {
  auth: AuthResult;
  body: Record<string, unknown>;
  originalModel: string;
  modelInfo: NonNullable<Awaited<ReturnType<typeof getModelInfo>>>;
};

export type AuthorizedModelContext = ResolvedModel & {
  provider: OpenAICompatibleProvider;
};

const MAX_CASCADE_LEVELS = 10;

export function computePrefixHashes(model: string, body: Record<string, unknown>): string[] {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(model);
  hasher.update("\0");
  const hashes: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown> | null | undefined;
    const role = String(msg?.role ?? "");
    const content = String(msg?.content ?? "");
    hasher.update(role);
    hasher.update(":");
    hasher.update(content);
    hasher.update("\n");

    if ((i + 1) % 2 === 0 || i === messages.length - 1) {
      hashes.push(hasher.copy().digest("hex").slice(0, 16));
    }
  }

  hashes.reverse();
  if (hashes.length > MAX_CASCADE_LEVELS) {
    hashes.length = MAX_CASCADE_LEVELS;
  }
  return hashes;
}

export async function resolveAuth(req: Request): Promise<Response | AuthResult> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) {
    return authCheckResponse;
  }

  const xAppHeader = req.headers.get("x-application");
  if (!xAppHeader) {
    return authCheckResponse;
  }
  const appId = await resolveApplicationByName(xAppHeader, authCheckResponse.orgId);
  if (!appId) {
    return errorResponse(`Application "${xAppHeader}" not found`, 404);
  }
  return { ...authCheckResponse, applicationId: appId };
}

export async function resolveModel(
  req: Request
): Promise<Response | ResolvedModel> {
  const auth = await resolveAuth(req);
  if (auth instanceof Response) {
    return auth;
  }

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
  const prefixHashes = computePrefixHashes(originalModel, body);
  const modelInfo = await getModelInfo(auth.orgId, originalModel, prefixHashes.length > 0 ? prefixHashes : undefined);
  if (!modelInfo) {
    return errorResponse("Model not found", 404);
  }

  releaseCallbacks.set(req, modelInfo.release);

  return {
    auth,
    body,
    originalModel,
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
