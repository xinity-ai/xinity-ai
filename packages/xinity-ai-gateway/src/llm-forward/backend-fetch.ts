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
  const fetchInit = { ...init, headers };
  if (tlsOptions) {
    (fetchInit as Record<string, unknown>).tls = tlsOptions;
  }
  return fetch(url, fetchInit);
}
