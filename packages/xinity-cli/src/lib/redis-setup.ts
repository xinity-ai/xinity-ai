/**
 * Redis/Valkey discovery and setup, split into planning and apply halves.
 *
 * `planRedis` finds or asks for a connection URL and, when the user opts
 * into setup, decides the install/start commands, all without changing the
 * host. `applyRedisPlan` executes the decided commands and persists the URL.
 */
import { randomBytes } from "crypto";
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn, readSecrets } from "./host.ts";
import { pass, fail, info, promptOrUndefined, reportElevationOutcome, warn } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { SECRETS_DIR, ENV_DIR } from "./component-meta.ts";
import type { ConnectionResult } from "./connectivity.ts";

async function testRedisWithSpinner(url: string, host: Host): Promise<ConnectionResult> {
  const { testRedisConnection } = await import("./connectivity.ts");
  const spinner = p.spinner();
  spinner.start("Testing Redis connection…");
  const result = await testRedisConnection(url, host);
  spinner.stop(result.success ? "Redis connection successful" : "Redis connection failed");
  if (!result.success && result.error) {
    p.log.error(pc.dim(result.error));
  }
  return result;
}

// ─── Package-manager definitions ────────────────────────────────────────────

type RedisVariant = "redis" | "valkey";

interface PackageManager {
  name: string;
  /** The binary on PATH that indicates this PM is available. */
  bin: string;
  /** Shell command to install each variant. */
  install: Record<RedisVariant, string>;
  /** Shell command to start the service for each variant. */
  start: Record<RedisVariant, string>;
  /** True when `sudo` is NOT needed (e.g. macOS Homebrew). */
  userIsSuper: boolean;
}

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    name: "apt",
    bin: "apt-get",
    install: { redis: "apt-get install -y redis-server", valkey: "apt-get install -y valkey" },
    start: { redis: "systemctl start redis-server", valkey: "systemctl start valkey" },
    userIsSuper: false,
  },
  {
    name: "dnf",
    bin: "dnf",
    install: { redis: "dnf install -y redis", valkey: "dnf install -y valkey" },
    start: { redis: "systemctl start redis", valkey: "systemctl start valkey" },
    userIsSuper: false,
  },
  {
    name: "pacman",
    bin: "pacman",
    install: { redis: "pacman -S --noconfirm redis", valkey: "pacman -S --noconfirm valkey" },
    start: { redis: "systemctl start redis", valkey: "systemctl start valkey" },
    userIsSuper: false,
  },
  {
    name: "zypper",
    bin: "zypper",
    install: { redis: "zypper install -y redis", valkey: "zypper install -y valkey" },
    start: { redis: "systemctl start redis", valkey: "systemctl start valkey" },
    userIsSuper: false,
  },
  {
    name: "brew",
    bin: "brew",
    install: { redis: "brew install redis", valkey: "brew install valkey" },
    start: { redis: "brew services start redis", valkey: "brew services start valkey" },
    userIsSuper: true,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function detectPackageManager(host: Host): Promise<PackageManager | undefined> {
  for (const pm of PACKAGE_MANAGERS) {
    if (await commandExistsOn(host, pm.bin)) return pm;
  }
  return undefined;
}

function generatePassword(length = 24): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

/** Detect which variant (redis or valkey) is installed. */
async function detectVariant(host: Host): Promise<RedisVariant | null> {
  if (await commandExistsOn(host, "redis-server")) return "redis";
  if (await commandExistsOn(host, "redis-cli")) return "redis";
  if (await commandExistsOn(host, "valkey-server")) return "valkey";
  if (await commandExistsOn(host, "valkey-cli")) return "valkey";
  return null;
}

/** Check whether a Redis/Valkey server is reachable. */
async function isRedisRunning(host: Host): Promise<boolean> {
  // Try redis-cli first, then valkey-cli
  for (const cli of ["redis-cli", "valkey-cli"]) {
    if (await commandExistsOn(host, cli)) {
      const res = await host.run([cli, "ping"]);
      if (res.ok && res.output.includes("PONG")) return true;
    }
  }
  // Fallback: try common systemd unit names
  for (const unit of ["redis-server", "redis", "valkey"]) {
    const res = await host.run(["systemctl", "is-active", unit]);
    if (res.ok) return true;
  }
  return false;
}

const SYSTEMD_START_FALLBACK: Record<RedisVariant, string> = {
  redis: "systemctl start redis-server",
  valkey: "systemctl start valkey",
};

function startCommandFor(variant: RedisVariant, pm: PackageManager | undefined): string {
  return pm?.start[variant] ?? SYSTEMD_START_FALLBACK[variant];
}

// ─── Plan / apply model ─────────────────────────────────────────────────────

export interface RedisProvision {
  variant: RedisVariant;
  installCmd?: string;
  startCmd?: string;
  /** brew and similar: commands run as the regular user, not root. */
  userIsSuper: boolean;
}

export interface RedisPlan {
  url: string;
  /** Store the URL into the secrets dir during apply. */
  persist: boolean;
  provision?: RedisProvision;
}

async function runProvisionCommand(
  host: Host,
  prov: RedisProvision,
  cmd: string,
  label: string,
  messages: { success: string; failed: string },
): Promise<boolean> {
  if (prov.userIsSuper) {
    const res = await host.run(["sh", "-c", cmd]);
    if (res.ok) {
      pass(label, messages.success);
      return true;
    }
    fail(label, res.output || messages.failed);
    return false;
  }

  const result = await host.withElevation(cmd, label);
  return reportElevationOutcome(result, label, {
    success: messages.success,
    failed: result.output || messages.failed,
  });
}

/** Execute a decided redis plan: install/start when planned, then persist the URL. */
export async function applyRedisPlan(plan: RedisPlan, host: Host): Promise<boolean> {
  const prov = plan.provision;
  if (prov) {
    if (prov.installCmd && !(await runProvisionCommand(host, prov, prov.installCmd, `Install ${prov.variant}`, {
      success: `${prov.variant} installed`,
      failed: "Installation failed",
    }))) {
      return false;
    }
    if (prov.startCmd && !(await runProvisionCommand(host, prov, prov.startCmd, `Start ${prov.variant}`, {
      success: "Service started",
      failed: "Failed to start service",
    }))) {
      return false;
    }
    await testRedisWithSpinner(plan.url, host);
  }

  if (plan.persist) await persistRedisUrl(host, plan.url);
  return true;
}

/** Review lines for the redis actions in an `up all` plan (empty when nothing will change). */
export function describeRedisPlan(plan: RedisPlan): string[] {
  const lines: string[] = [];
  if (plan.provision?.installCmd) lines.push(`  install: ${plan.provision.installCmd}`);
  if (plan.provision?.startCmd) lines.push(`  start: ${plan.provision.startCmd}`);
  if (plan.persist) lines.push(`  store REDIS_URL in ${SECRETS_DIR}`);
  if (lines.length === 0) return [];
  const head = plan.provision
    ? `Provision ${plan.provision.variant} and store the connection URL`
    : "Store the Redis connection URL";
  return [head, ...lines];
}

async function waitForManualInstall(host: Host): Promise<boolean> {
  p.note(
    [
      "Please install Redis or Valkey using your system's package manager.",
      "Common commands:",
      "",
      `  ${pc.dim("# Debian/Ubuntu")}`,
      `  sudo apt install redis-server`,
      `  ${pc.dim("# or")}`,
      `  sudo apt install valkey`,
      "",
      `  ${pc.dim("# Fedora/RHEL")}`,
      `  sudo dnf install redis`,
      "",
      `  ${pc.dim("# Arch Linux")}`,
      `  sudo pacman -S redis`,
      "",
      `  ${pc.dim("# macOS")}`,
      `  brew install redis`,
      "",
      "After installing, make sure the service is running.",
    ].join("\n"),
    "Manual installation required",
  );

  const done = await p.confirm({
    message: "Have you installed and started Redis/Valkey?",
    initialValue: false,
  });

  if (p.isCancel(done) || !done) return false;

  if (await isRedisRunning(host)) {
    pass("Redis", "Service is running");
    return true;
  }

  warn("Redis", "Service does not appear to be running yet");
  const continueAnyway = await p.confirm({
    message: "Continue anyway?",
    initialValue: false,
  });
  return !p.isCancel(continueAnyway) && continueAnyway;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Build a REDIS_URL from user input or defaults. Prompts only. */
async function configureRedisUrl(): Promise<string | undefined> {
  p.log.step(pc.bold("Configure Redis connection"));

  const hostInput = await promptOrUndefined(p.text({
    message: "Redis host",
    placeholder: "localhost",
    defaultValue: "localhost",
  }));
  if (hostInput === undefined) return undefined;

  const portInput = await promptOrUndefined(p.text({
    message: "Redis port",
    placeholder: "6379",
    defaultValue: "6379",
    validate: (val) => {
      if (!val) return undefined;
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1 || n > 65535) return "Must be a valid port number";
      return undefined;
    },
  }));
  if (portInput === undefined) return undefined;

  const setPassword = await promptOrUndefined(p.confirm({
    message: "Set a password for Redis?",
    initialValue: false,
  }));
  if (setPassword === undefined) return undefined;

  let password: string | undefined;
  if (setPassword) {
    const useGenerated = await promptOrUndefined(p.confirm({
      message: "Generate a random password?",
      initialValue: true,
    }));
    if (useGenerated === undefined) return undefined;

    if (useGenerated) {
      password = generatePassword();
      info("Password", `Generated: ${pc.cyan(password)}`);
    } else {
      const pw = await promptOrUndefined(p.password({
        message: "Redis password",
        validate: (val) => {
          if (!val || val.length < 4) return "Password must be at least 4 characters";
          return undefined;
        },
      }));
      if (pw === undefined) return undefined;
      password = pw;
    }
  }

  const url = password
    ? `redis://:${encodeURIComponent(password)}@${hostInput}:${portInput}`
    : `redis://${hostInput}:${portInput}`;

  p.note(url, "REDIS_URL");

  return url;
}

// ─── Main entry point ───────────────────────────────────────────────────────

function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return url.replace(/:([^@]+)@/, ":****@");
  }
}

async function persistRedisUrl(host: Host, url: string): Promise<void> {
  // Only write if the value actually changed.
  const existing = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  if (existing.secrets.REDIS_URL === url) return;

  const escaped = url.replace(/'/g, "'\\''");
  await host.withElevation(
    `mkdir -p '${SECRETS_DIR}' && chmod 700 '${SECRETS_DIR}'` +
    ` && printf '%s' '${escaped}' > '${SECRETS_DIR}/REDIS_URL' && chmod 600 '${SECRETS_DIR}/REDIS_URL'`,
    "Store Redis connection URL",
  );
}

/**
 * Planning half: discover REDIS_URL from stored secrets, environment, or
 * component configs, or guide the user to a URL (optionally deciding an
 * install). Reads and prompts only; `applyRedisPlan` makes the changes.
 *
 * Returns undefined if the user cancelled.
 */
export async function planRedis(host: Host): Promise<RedisPlan | undefined> {
  // 1. Check stored secret
  const stored = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  if (stored.secrets.REDIS_URL) {
    const url = stored.secrets.REDIS_URL;
    info("Redis connection", `Found stored URL: ${redactRedisUrl(url)}`);
    const result = await testRedisWithSpinner(url, host);
    if (result.success) {
      return { url, persist: false };
    }

    // Stored URL is stale, offer to reconfigure
    const action = await p.select({
      message: "Stored Redis URL failed connectivity test.",
      options: [
        { value: "reenter", label: "Enter a new URL" },
        { value: "setup", label: "Set up a new Redis instance" },
        { value: "keep", label: "Use the stored URL anyway" },
      ],
    });
    if (p.isCancel(action)) { p.cancel("Cancelled."); return undefined; }
    if (action === "keep") return { url, persist: false };
    if (action === "setup") return planRedisSetup(host);
    const newUrl = await promptAndValidateRedisUrl(host);
    return newUrl ? { url: newUrl, persist: true } : undefined;
  }

  // 2. Check environment variable
  if (process.env.REDIS_URL) {
    info("Redis connection", "Using REDIS_URL from environment");
    return { url: process.env.REDIS_URL, persist: true };
  }

  // 3. Check installed component env files on the target host
  for (const component of ["gateway", "dashboard", "daemon"]) {
    const envPath = `${ENV_DIR}/${component}.env`;
    if (await host.fileExists(envPath)) {
      const content = await host.readFile(envPath);
      if (content) {
        const env = parseEnvString(content);
        if (env.REDIS_URL) {
          info("Redis connection", `Found in ${component}.env`);
          return { url: env.REDIS_URL, persist: true };
        }
      }
    }
  }

  // 4. No existing connection found, ask user how to proceed
  const choice = await p.select({
    message: "No existing Redis connection found. Do you already have a Redis/Valkey instance?",
    options: [
      {
        value: "existing",
        label: "Yes, I have a connection URL",
        hint: "enter your Redis connection string",
      },
      {
        value: "setup",
        label: "No, help me set one up",
        hint: "detect/install Redis or Valkey and configure it",
      },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    return undefined;
  }

  if (choice === "setup") return planRedisSetup(host);

  // Existing instance, prompt for URL then validate connectivity
  const url = await promptAndValidateRedisUrl(host);
  return url ? { url, persist: true } : undefined;
}

/**
 * Prompt for a Redis connection URL and test connectivity, allowing retries.
 */
async function promptAndValidateRedisUrl(host: Host): Promise<string | undefined> {
  while (true) {
    const value = await p.text({
      message: "REDIS_URL",
      placeholder: "redis://localhost:6379",
      validate: (val) => {
        if (!val) return "A connection URL is required";
        if (!val.startsWith("redis")) return "Must be a Redis connection URL";
        return undefined;
      },
    });
    if (p.isCancel(value)) {
      p.cancel("Cancelled.");
      return undefined;
    }

    const result = await testRedisWithSpinner(value, host);
    if (result.success) {
      return value;
    }

    const action = await p.select({
      message: "Could not connect to Redis.",
      options: [
        { value: "retry", label: "Enter a different URL" },
        { value: "proceed", label: "Use this URL anyway" },
      ],
    });
    if (p.isCancel(action) || action === "proceed") return value;
  }
}

/**
 * Interactive setup planning: detect what is installed and running, decide
 * the install/start commands, and prompt for the connection details. Nothing
 * executes here; the decided commands run in `applyRedisPlan`.
 */
async function planRedisSetup(host: Host): Promise<RedisPlan | undefined> {
  p.log.step(pc.bold("Redis / Valkey setup"));

  // Step 1: Is Redis/Valkey installed?
  const variant = await detectVariant(host);

  if (!variant) {
    info("Redis/Valkey", "Not found on this system");

    const pm = await detectPackageManager(host);
    if (pm) {
      info("Package manager", `Detected ${pc.cyan(pm.name)}`);

      // Let user choose between Redis and Valkey
      const variantChoice = await p.select({
        message: "Which variant would you like to install?",
        options: [
          { value: "redis" as const, label: "Redis", hint: "the original" },
          { value: "valkey" as const, label: "Valkey", hint: "community fork, fully compatible" },
        ],
      });
      if (p.isCancel(variantChoice)) return undefined;

      const proceed = await p.confirm({
        message: `Install ${variantChoice} using ${pc.cyan(pm.name)}?`,
        initialValue: true,
      });
      if (p.isCancel(proceed) || !proceed) return undefined;

      const url = await configureRedisUrl();
      if (!url) return undefined;
      return {
        url,
        persist: true,
        provision: {
          variant: variantChoice,
          installCmd: pm.install[variantChoice],
          startCmd: pm.start[variantChoice],
          userIsSuper: pm.userIsSuper,
        },
      };
    }

    // Unknown package manager: the user installs by hand, we only verify.
    warn("Package manager", "Could not detect a supported package manager");
    const ready = await waitForManualInstall(host);
    if (!ready) return undefined;

    const url = await configureRedisUrl();
    return url ? { url, persist: true } : undefined;
  }

  // Step 2: Redis/Valkey is installed, is it running?
  if (await isRedisRunning(host)) {
    pass(variant, "Installed and running");
    const url = await configureRedisUrl();
    return url ? { url, persist: true } : undefined;
  }

  // Installed but not running
  warn(variant, "Installed but not running (will be started on apply)");

  const pm = await detectPackageManager(host);
  const url = await configureRedisUrl();
  if (!url) return undefined;
  return {
    url,
    persist: true,
    provision: {
      variant,
      startCmd: startCommandFor(variant, pm),
      userIsSuper: pm?.userIsSuper ?? false,
    },
  };
}

function describeRedisPlanDryRun(plan: RedisPlan): void {
  if (plan.provision?.installCmd) {
    info("Dry run", `Would install ${plan.provision.variant}: ${pc.dim(plan.provision.installCmd)}`);
  }
  if (plan.provision?.startCmd) {
    info("Dry run", `Would start ${plan.provision.variant}: ${pc.dim(plan.provision.startCmd)}`);
  }
  if (plan.persist) {
    info("Dry run", `Would store REDIS_URL in ${SECRETS_DIR}`);
  }
}

/**
 * Entry point for `xinity up infra-redis`: plan, then immediately apply (or
 * describe, on dry runs). If a working connection already exists, offers to
 * keep it or reconfigure.
 */
export async function infraRedis(host: Host, dryRun: boolean): Promise<string | undefined> {
  let plan: RedisPlan | undefined;

  const stored = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  const storedUrl = stored.secrets.REDIS_URL;
  if (storedUrl && (await testRedisWithSpinner(storedUrl, host)).success) {
    info("Redis connection", `Current: ${redactRedisUrl(storedUrl)}`);
    const action = await p.select({
      message: "Redis is configured and reachable.",
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "reenter", label: "Enter a different URL" },
        { value: "setup", label: "Set up a new Redis instance" },
      ],
    });
    if (p.isCancel(action) || action === "keep") return storedUrl;
    if (action === "reenter") {
      const newUrl = await promptAndValidateRedisUrl(host);
      plan = newUrl ? { url: newUrl, persist: true } : undefined;
    } else {
      plan = await planRedisSetup(host);
    }
  } else {
    // No stored URL, or stored but unreachable: planRedis owns the stale-URL flow.
    plan = await planRedis(host);
  }

  if (!plan) return undefined;
  if (dryRun) {
    describeRedisPlanDryRun(plan);
    return plan.url;
  }
  return (await applyRedisPlan(plan, host)) ? plan.url : undefined;
}
