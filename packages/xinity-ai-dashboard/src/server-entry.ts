/**
 * Production entrypoint, compiled by build.ts.
 *
 * Importing the adapter's entry starts Bun.serve and initialises SvelteKit, which runs
 * hooks.server.ts and with it the background services. Everything the adapter reads from
 * the environment has to be in place before that import.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activationRefusal, exitOnHealthFlag, type TlsConfig } from "common-env";
import { dashboardConfig } from "./lib/server/config-schema";
import { config } from "./lib/server/config";
import { rootLogger } from "./lib/server/logging";

await exitOnHealthFlag({ ...config.server, tls: !!config.tls });

const refusal = activationRefusal(dashboardConfig, rootLogger);
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

// The adapter reads these from process.env when its module loads, so a declared value reaches
// it only by being placed here. The prefix matches envPrefix in vite.config.ts. Assigned one at
// a time on purpose: a spread would put DB_CONNECTION_URL, BETTER_AUTH_SECRET, LICENSE_KEY and
// the S3 credentials somewhere every child process and crash dump can read them, for no gain.
const ADAPTER_ENV_PREFIX = "BUN_SVELTE_ADAPTER_";
process.env[`${ADAPTER_ENV_PREFIX}HOST`] = config.server.host;
process.env[`${ADAPTER_ENV_PREFIX}PORT`] = String(config.server.port);
process.env[`${ADAPTER_ENV_PREFIX}CONNECTION_IDLE_TIMEOUT`] = String(config.server.idleTimeout);
process.env[`${ADAPTER_ENV_PREFIX}ORIGIN`] = config.origin;
// Not for the adapter: orpc-client is browser-importable, so the environment is the only
// place it can read an absolute URL from while rendering on the server.
process.env.ORIGIN = config.origin;
if (config.server.unixSocket) {
  process.env[`${ADAPTER_ENV_PREFIX}SOCKET_PATH`] = config.server.unixSocket;
}
if (config.tls) {
  const { cert, key } = await writeTlsMaterial(config.tls);
  process.env[`${ADAPTER_ENV_PREFIX}TLS_CERT_FILE`] = cert;
  process.env[`${ADAPTER_ENV_PREFIX}TLS_KEY_FILE`] = key;
}

// @ts-ignore: the adapter's server entry does not exist until build.ts has run vite.
await import("../.svelte-kit/output/server/adapter-index.js");
