/**
 * Production entrypoint, compiled by build.ts.
 *
 * Importing the adapter entry starts Bun.serve, since its self-start check is true inside
 * the compiled bundle, but it builds the SvelteKit server only once a request reaches its
 * fetch handler. hooks.server.ts starts the deployment sync service, the notification
 * scheduler and the shutdown handlers from its module body, so an idle process would run
 * none of them. One request to ourselves forces that initialisation.
 */
import { serveOptions, tlsOptions } from "../build/index.js";

/** A real route, since this app logs 404s at error level and a warm-up must not look like a fault. */
const WARMUP_PATH = "/login/";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

function warmupTarget() {
  const { unix, hostname, port } = serveOptions();
  const scheme = "tls" in tlsOptions() ? "https" : "http";
  // We are the one serving the certificate, so there is nothing to verify it against.
  const options = scheme === "https" ? { tls: { rejectUnauthorized: false } } : {};

  if (unix) {
    return { url: `${scheme}://localhost${WARMUP_PATH}`, options: { ...options, unix } };
  }
  const host = !hostname || WILDCARD_HOSTS.has(hostname) ? "127.0.0.1" : hostname;
  return { url: `${scheme}://${host}:${port}${WARMUP_PATH}`, options };
}

const { url, options } = warmupTarget();
try {
  await fetch(url, options);
} catch (err) {
  console.error(`[startup] Warm-up request to ${url} failed. Background services will start with the first request instead.`, err);
}
