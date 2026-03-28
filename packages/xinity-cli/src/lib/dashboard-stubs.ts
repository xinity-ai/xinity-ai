/**
 * Single source of truth for dashboard module stubs.
 *
 * Both build.ts (Bun.build bundler plugin, needs JS source strings)
 * and dashboard-plugin.ts (Bun runtime plugin, needs objects) consume this.
 *
 * When adding a new export to a stubbed dashboard module, add it HERE.
 */

// ── Helpers ──────────────────────────────────────────────────────────────

const noop = () => {};
const asyncNoop = async () => {};

const dummyLogger: Record<string, unknown> = {
  child: () => dummyLogger,
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  fatal: noop,
  trace: noop,
  level: "silent",
};

// ── Server module stubs ──────────────────────────────────────────────────

export const serverStubs: Record<string, Record<string, unknown>> = {
  "$lib/server/serverenv": {
    serverEnv: {},
    getDB: noop,
    isInstanceAdmin: () => false,
  },
  "$lib/server/logging": {
    rootLogger: dummyLogger,
  },
  "$lib/server/auth-server": {
    auth: { api: { getSession: asyncNoop, hasPermission: asyncNoop } },
    getGreenlitCallId: () => "",
  },
  "$lib/server/roles": {
    ac: { statements: {} },
    labeler: {},
    admin: {},
    owner: {},
    member: {},
    viewer: {},
    isRoleAvailable: () => true,
  },
  "$lib/server/email": {
    sendEmail: asyncNoop,
  },
  "$lib/server/lib/modelloader.mod": {
    loadModelData: () => [],
    getModelInfo: () => null,
    InvalidModelInfo: class extends Error {},
  },
  "$lib/server/lib/orchestration.mod": {
    assembleModelRequirementTable: asyncNoop,
    syncDeployedModels: asyncNoop,
    startDeploymentSyncService: asyncNoop,
  },
  "$lib/server/license": {
    parseLicense: () => ({ valid: false, reason: "stub" }),
    getLicense: () => ({ valid: false, reason: "stub" }),
    resetLicenseCache: noop,
    hasFeature: () => false,
    maxNodes: () => 1,
    tierName: () => "free",
    licenseeName: () => null,
    isExpired: () => false,
    isInGracePeriod: () => false,
    hasOriginMismatch: () => false,
    getLicenseSummary: () => ({
      tier: "free",
      licensee: null,
      expired: false,
      inGracePeriod: false,
      originMismatch: false,
      maxNodes: 1,
      features: { sso: false, multiOrg: false, ssoSelfManage: false, allRoles: false },
    }),
  },
};

// ── $app/* stubs ─────────────────────────────────────────────────────────

export const appStubs: Record<string, Record<string, unknown>> = {
  "$app/environment": { browser: false, dev: false, building: true },
  "$app/stores": {},
};

// ── Svelte component paths needing empty stubs ──────────────────────────

export const svelteComponentStubs = [
  "$lib/components/mailTemplates/EmailVerificationTemplate.svelte",
  "$lib/components/mailTemplates/EmailForgotPasswordTemplate.svelte",
  "$lib/components/mailTemplates/EmailInvitationTemplate.svelte",
  "$lib/components/mailTemplates/EmailEmailChangeConfirmationTemplate.svelte",
] as const;

// ── JS source generation (for Bun.build onLoad) ─────────────────────────

/** Convert a JS value to its source-code representation. */
function valueToSource(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return value.toString();
  if (Array.isArray(value)) return `[${value.map(valueToSource).join(", ")}]`;

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, v]) => `${k}: ${valueToSource(v)}`).join(", ")} }`;
  }

  return "undefined";
}

/**
 * Manual JS source for stubs that can't be auto-serialized.
 * Only $lib/server/logging needs this: dummyLogger.child references
 * dummyLogger by closure, which toString() can't capture as valid source.
 * Changes to $lib/server/logging exports must update both serverStubs AND here.
 */
const sourceOverrides: Record<string, string> = {
  "$lib/server/logging": `
    const noop = () => {};
    const dummyLogger = {
      child: () => dummyLogger,
      info: noop, warn: noop, error: noop,
      debug: noop, fatal: noop, trace: noop,
      level: "silent",
    };
    export const rootLogger = dummyLogger;
  `,
};

/** Convert an object-form stub to ESM source string for Bun.build's onLoad. */
function toJsSource(specifier: string, exports: Record<string, unknown>): string {
  if (specifier in sourceOverrides) return sourceOverrides[specifier];

  const lines: string[] = [];
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value === "function" && value.toString().startsWith("class ")) {
      lines.push(`export ${value.toString().replace(/^class/, `class ${name}`)}`);
    } else {
      lines.push(`export const ${name} = ${valueToSource(value)};`);
    }
  }
  return lines.join("\n");
}

/** Pre-computed JS source for every server stub (keyed by $lib/ specifier). */
export const serverStubSources: Record<string, string> = Object.fromEntries(
  Object.entries(serverStubs).map(([spec, exp]) => [spec, toJsSource(spec, exp)]),
);

/** Pre-computed JS source for $app/* stubs. */
export const appStubSources: Record<string, string> = Object.fromEntries(
  Object.entries(appStubs).map(([spec, exp]) => [spec, toJsSource(spec, exp)]),
);
