/**
 * Production entrypoint, compiled by build.ts.
 *
 * Importing the adapter entry starts Bun.serve, since its self-start check is true inside
 * the compiled bundle, but it builds the SvelteKit server only once a request reaches its
 * fetch handler. hooks.server.ts starts the deployment sync service, the notification
 * scheduler and the shutdown handlers from its module body, so an idle process would run
 * none of them. One request to ourselves forces that initialisation.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activationRefusal, type TlsConfig } from "common-env";
import { dashboardConfig } from "./lib/server/config-schema";
import { config } from "./lib/server/config";
import { rootLogger } from "./lib/server/logging";

const refusal = activationRefusal(dashboardConfig, process.env, rootLogger);
if (refusal) {
  rootLogger.fatal(refusal);
  process.exit(1);
}

/** The adapter hands Bun a path, so PEM that came from the environment has to reach the disk to be served. */
async function writeTlsMaterial(tls: TlsConfig): Promise<{ cert: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "xinity-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  await writeFile(cert, tls.cert, { mode: 0o600 });
  await writeFile(key, tls.key, { mode: 0o600 });
  return { cert, key };
}

// The adapter reads these from process.env before any of our code runs, so a declared value
// reaches it only by being placed here. Assigned one at a time on purpose: a spread would put
// DB_CONNECTION_URL, BETTER_AUTH_SECRET, LICENSE_KEY and the S3 credentials somewhere every
// child process and crash dump can read them, for no gain.
process.env.HTTP_HOST = config.server.host;
process.env.HTTP_PORT = String(config.server.port);
process.env.HTTP_IDLE_TIMEOUT = String(config.server.idleTimeout);
process.env.HTTP_OVERRIDE_ORIGIN = config.server.origin;
process.env.HTTP_XFF_DEPTH = String(config.proxy.xffDepth);
if (config.server.unixSocket) {
  process.env.HTTP_SOCKET = config.server.unixSocket;
}
if (config.tls) {
  const { cert, key } = await writeTlsMaterial(config.tls);
  process.env.TLS_CERT_FILE = cert;
  process.env.TLS_KEY_FILE = key;
}
if (config.proxy.header) {
  process.env.HTTP_IP_HEADER = config.proxy.header;
}

const { serveOptions, tlsOptions } = await import("../build/index.js");

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
