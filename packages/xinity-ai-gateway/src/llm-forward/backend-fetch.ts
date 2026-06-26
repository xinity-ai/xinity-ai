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

export type IdleTimeout = { signal: AbortSignal; reset: () => void; clear: () => void };

/**
 * Create a resettable idle timeout. Each call to `reset()` restarts the
 * countdown. If the timer fires, the returned signal aborts with a
 * TimeoutError identical to AbortSignal.timeout().
 */
export function createIdleTimeout(ms: number = env.BACKEND_TIMEOUT_MS): IdleTimeout {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }, ms);
  }

  function clear() {
    clearTimeout(timer);
  }

  reset();
  return { signal: controller.signal, reset, clear };
}

/** Post a JSON body to a daemon-proxied backend endpoint with the standard timeout. */
export function backendPostJson(
  target: BackendTarget,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return backendFetch(backendUrl(target.host, target.model, path, target.tls), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    authToken: target.authToken ?? undefined,
  });
}

/**
 * Post a multipart form to a daemon-proxied backend endpoint.
 * No Content-Type is set so fetch derives the multipart boundary.
 */
export function backendPostForm(
  target: BackendTarget,
  path: string,
  form: FormData,
  signal: AbortSignal,
): Promise<Response> {
  return backendFetch(backendUrl(target.host, target.model, path, target.tls), {
    method: "POST",
    body: form,
    signal,
    authToken: target.authToken ?? undefined,
  });
}
