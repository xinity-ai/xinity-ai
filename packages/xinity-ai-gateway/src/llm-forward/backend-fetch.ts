import { env } from "../env";

const customCa = env.XINITY_INFERENCE_CA;
const tlsOptions = customCa ? { ca: customCa } : undefined;

export const hasCustomCa = !!customCa;

/** Build the full URL for a request through the daemon proxy. */
export function backendUrl(host: string, model: string, path: string, tls: boolean): string {
  const protocol = tls ? "https" : "http";
  return `${protocol}://${host}/proxy/${encodeURIComponent(model)}${path}`;
}

/** Perform a fetch to a daemon inference proxy with auth token and optional custom CA. */
export function backendFetch(url: string | URL | Request, init?: RequestInit & { authToken?: string }): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.authToken) {
    headers.set("authorization", `Bearer ${init.authToken}`);
  }
  return fetch(url, { ...init, headers, ...(tlsOptions ? { tls: tlsOptions } : {}) });
}

type BackendTarget = { host: string; model: string; tls: boolean; authToken: string | null };

/** Post a JSON body to a daemon-proxied backend endpoint with the standard timeout. */
export function backendPostJson(
  target: BackendTarget,
  path: string,
  body: unknown,
  clientSignal: AbortSignal,
): Promise<Response> {
  return backendFetch(backendUrl(target.host, target.model, path, target.tls), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([clientSignal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
    authToken: target.authToken ?? undefined,
  });
}
