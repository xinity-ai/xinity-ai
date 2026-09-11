/**
 * Zod `.meta()` marker for env vars that should be treated as secrets.
 * Used by the CLI to decide which values go into LoadCredential files
 * vs. the plain EnvironmentFile.
 *
 * Usage: `DB_CONNECTION_URL: z.url().meta(secret())`
 */
export function secret() {
  return { secret: true as const };
}

/**
 * Zod `.meta()` marker for env vars that are expert/advanced settings.
 * Fields without this marker are considered essential. Used by the CLI
 * and dashboard to separate basic setup from advanced tuning.
 *
 * Usage: `BACKEND_TIMEOUT_MS: z.coerce.number().meta(expert())`
 */
export function expert() {
  return { expert: true as const };
}

/**
 * Zod `.meta()` marker for env vars that should be forwarded to the client
 * via SvelteKit layout data. These fields are read on the server and passed
 * through as layout data, then made available via `getClientEnv()` in
 * Svelte components. Values must be safe to expose to the browser.
 *
 * Usage: `GATEWAY_URL: z.url().meta(clientPublic())`
 */
export function clientPublic() {
  return { public: true as const };
}

/** POSIX-safe single-quote shell escape. Strings made of only `[A-Za-z0-9@%+=:,./_-]` are returned as-is. */
export function quoteShellArg(s: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Join an argv array into a single shell-safe command string. */
export function quoteShellArgv(argv: string[]): string {
  return argv.map(quoteShellArg).join(" ");
}

export * from "./config/leaf-types";
export * from "./config/group";
export * from "./config/build";
export * from "./config/activation";
export * from "./config/resolve";
export * from "./config/shared-groups";
export * from "./deployment-settings";
export * from "./metrics-auth";
export * from "./metrics-format";
export * from "./process-metrics";
export * from "./http-metrics";
export * from "./service-url";
export * from "./tether-protocol";
export * from "./content-hash";
