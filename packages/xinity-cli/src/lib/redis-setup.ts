/**
 * Interactive Redis/Valkey setup assistant for `xinity up redis`.
 *
 * Guides the user through detecting, installing, starting, and
 * configuring a Redis or Valkey instance for the gateway's caching
 * and load-balancing state.
 *
 * All shell operations go through the Host interface so this works
 * identically for local and remote (--target-host) execution.
 */
import { randomBytes } from "crypto";
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn, readSecrets } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { SECRETS_DIR, ENV_DIR } from "./component-meta.ts";

// ─── Package-manager definitions ────────────────────────────────────────────

type RedisVariant = "redis" | "valkey";

interface PackageManager {
  name: string;
  /** The binary on PATH that indicates this PM is available. */
  bin: string;
  /** Shell command to install Redis. */
  installRedisCmd: string;
  /** Shell command to install Valkey. */
  installValkeyCmd: string;
  /** Shell command to start the service. */
  startRedisCmd: string;
  startValkeyCmd: string;
  /** True when `sudo` is NOT needed (e.g. macOS Homebrew). */
  userIsSuper: boolean;
}

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    name: "apt",
    bin: "apt-get",
    installRedisCmd: "apt-get install -y redis-server",
    installValkeyCmd: "apt-get install -y valkey",
    startRedisCmd: "systemctl start redis-server",
    startValkeyCmd: "systemctl start valkey",
    userIsSuper: false,
  },
  {
    name: "dnf",
    bin: "dnf",
    installRedisCmd: "dnf install -y redis",
    installValkeyCmd: "dnf install -y valkey",
    startRedisCmd: "systemctl start redis",
    startValkeyCmd: "systemctl start valkey",
    userIsSuper: false,
  },
  {
    name: "pacman",
    bin: "pacman",
    installRedisCmd: "pacman -S --noconfirm redis",
    installValkeyCmd: "pacman -S --noconfirm valkey",
    startRedisCmd: "systemctl start redis",
    startValkeyCmd: "systemctl start valkey",
    userIsSuper: false,
  },
  {
    name: "zypper",
    bin: "zypper",
    installRedisCmd: "zypper install -y redis",
    installValkeyCmd: "zypper install -y valkey",
    startRedisCmd: "systemctl start redis",
    startValkeyCmd: "systemctl start valkey",
    userIsSuper: false,
  },
  {
    name: "brew",
    bin: "brew",
    installRedisCmd: "brew install redis",
    installValkeyCmd: "brew install valkey",
    startRedisCmd: "brew services start redis",
    startValkeyCmd: "brew services start valkey",
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

/** Try to start the Redis/Valkey service. */
async function startRedis(
  host: Host,
  variant: RedisVariant,
  pm: PackageManager | undefined,
  dryRun: boolean,
): Promise<boolean> {
  const startCmd = pm
    ? variant === "valkey" ? pm.startValkeyCmd : pm.startRedisCmd
    : variant === "valkey" ? "systemctl start valkey" : "systemctl start redis-server";

  if (dryRun) {
    info("Dry run", `Would start ${variant}: ${pc.dim(startCmd)}`);
    return true;
  }

  if (pm?.userIsSuper) {
    const res = await host.run(["sh", "-c", startCmd]);
    if (res.ok) {
      pass(variant, "Service started");
      return true;
    }
    fail(variant, "Failed to start service");
    return false;
  }

  const result = await host.withElevation(startCmd, `Start ${variant}`);
  if (result.success) {
    pass(variant, "Service started");
    return true;
  }
  if (result.skipped) {
    warn(variant, "Skipped starting the service");
  } else {
    fail(variant, result.output || "Failed to start service");
  }
  return false;
}

// ─── Install flow ───────────────────────────────────────────────────────────

async function installRedis(
  host: Host,
  variant: RedisVariant,
  pm: PackageManager,
  dryRun: boolean,
): Promise<boolean> {
  const installCmd = variant === "valkey" ? pm.installValkeyCmd : pm.installRedisCmd;

  const proceed = await p.confirm({
    message: `Install ${variant} using ${pc.cyan(pm.name)}?`,
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) return false;

  if (dryRun) {
    info("Dry run", `Would install ${variant}: ${pc.dim(installCmd)}`);
    return true;
  }

  if (pm.userIsSuper) {
    const spinner = p.spinner();
    spinner.start(`Installing ${variant} via ${pm.name}…`);
    const res = await host.run(["sh", "-c", installCmd]);
    if (!res.ok) {
      spinner.stop("Failed");
      fail("Install", res.output);
      return false;
    }
    spinner.stop(`${variant} installed`);
    pass("Install", `${variant} installed via ${pm.name}`);
    return true;
  }

  const result = await host.withElevation(installCmd, `Install ${variant}`);
  if (result.success) {
    pass("Install", `${variant} installed`);
    return true;
  }
  if (result.skipped) {
    warn("Install", "Skipped installation");
  } else {
    fail("Install", result.output || "Installation failed");
  }
  return false;
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

/** Build a REDIS_URL from user input or defaults. */
async function configureRedisUrl(
  host: Host,
  dryRun: boolean,
): Promise<string | undefined> {
  p.log.step(pc.bold("Configure Redis connection"));

  const hostInput = await p.text({
    message: "Redis host",
    placeholder: "localhost",
    defaultValue: "localhost",
  });
  if (p.isCancel(hostInput)) return undefined;

  const portInput = await p.text({
    message: "Redis port",
    placeholder: "6379",
    defaultValue: "6379",
    validate: (val) => {
      if (!val) return undefined;
      const n = parseInt(val);
      if (isNaN(n) || n < 1 || n > 65535) return "Must be a valid port number";
      return undefined;
    },
  });
  if (p.isCancel(portInput)) return undefined;

  const setPassword = await p.confirm({
    message: "Set a password for Redis?",
    initialValue: false,
  });
  if (p.isCancel(setPassword)) return undefined;

  let password: string | undefined;
  if (setPassword) {
    const useGenerated = await p.confirm({
      message: "Generate a random password?",
      initialValue: true,
    });
    if (p.isCancel(useGenerated)) return undefined;

    if (useGenerated) {
      password = generatePassword();
      info("Password", `Generated: ${pc.cyan(password)}`);
    } else {
      const pw = await p.password({
        message: "Redis password",
        validate: (val) => {
          if (!val || val.length < 4) return "Password must be at least 4 characters";
          return undefined;
        },
      });
      if (p.isCancel(pw)) return undefined;
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
    { sensitive: true },
  );
}

/**
 * Discover REDIS_URL from stored secrets, environment, or component configs.
 * If no existing URL is found, guides the user through an interactive
 * setup that can detect, install, and configure Redis/Valkey automatically.
 * Persists the result to the secrets directory for future runs.
 *
 * Returns a Redis URL if setup completed, or `undefined` if the user cancelled.
 */
export async function discoverRedisUrl(
  host: Host,
  dryRun: boolean,
): Promise<string | undefined> {
  const { testRedisConnection } = await import("./connectivity.ts");

  // 1. Check stored secret
  const stored = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  if (stored.secrets.REDIS_URL) {
    const url = stored.secrets.REDIS_URL;
    info("Redis connection", `Found stored URL: ${redactRedisUrl(url)}`);
    const ok = await testRedisConnection(url, host);
    if (ok) return url;

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
    if (action === "keep") return url;
    if (action === "setup") {
      const newUrl = await redisSetup(host, dryRun);
      if (newUrl) {
        await testRedisConnection(newUrl, host);
        if (!dryRun) await persistRedisUrl(host, newUrl);
      }
      return newUrl;
    }
    // reenter: fall through to promptAndValidateRedisUrl below
    const newUrl = await promptAndValidateRedisUrl(host);
    if (newUrl && !dryRun) await persistRedisUrl(host, newUrl);
    return newUrl;
  }

  // 2. Check environment variable
  if (process.env.REDIS_URL) {
    info("Redis connection", "Using REDIS_URL from environment");
    if (!dryRun) await persistRedisUrl(host, process.env.REDIS_URL);
    return process.env.REDIS_URL;
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
          if (!dryRun) await persistRedisUrl(host, env.REDIS_URL);
          return env.REDIS_URL;
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

  if (choice === "setup") {
    const url = await redisSetup(host, dryRun);
    if (url) {
      await testRedisConnection(url, host);
      if (!dryRun) await persistRedisUrl(host, url);
    }
    return url;
  }

  // Existing instance, prompt for URL then validate connectivity
  const url = await promptAndValidateRedisUrl(host);
  if (url && !dryRun) await persistRedisUrl(host, url);
  return url;
}

/**
 * Prompt for a Redis connection URL and test connectivity, allowing retries.
 */
async function promptAndValidateRedisUrl(host: Host): Promise<string | undefined> {
  const { testRedisConnection } = await import("./connectivity.ts");

  // eslint-disable-next-line no-constant-condition
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

    const ok = await testRedisConnection(value, host);
    if (ok) return value;

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
 * Interactive Redis/Valkey setup flow.
 *
 * Returns a REDIS_URL if setup completed, or `undefined` if the user cancelled.
 */
export async function redisSetup(host: Host, dryRun: boolean): Promise<string | undefined> {
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

      const installed = await installRedis(host, variantChoice, pm, dryRun);
      if (!installed) return undefined;

      const started = await startRedis(host, variantChoice, pm, dryRun);
      if (!started) return undefined;

      return configureRedisUrl(host, dryRun);
    }

    // Unknown package manager
    warn("Package manager", "Could not detect a supported package manager");
    if (dryRun) {
      info("Dry run", "Would ask user to install Redis/Valkey manually");
      return configureRedisUrl(host, dryRun);
    }
    const ready = await waitForManualInstall(host);
    if (!ready) return undefined;

    return configureRedisUrl(host, dryRun);
  }

  // Step 2: Redis/Valkey is installed, is it running?
  if (await isRedisRunning(host)) {
    pass(variant, "Installed and running");
    return configureRedisUrl(host, dryRun);
  }

  // Installed but not running
  warn(variant, "Installed but not running");

  const pm = await detectPackageManager(host);
  const started = await startRedis(host, variant, pm, dryRun);
  if (!started) return undefined;

  return configureRedisUrl(host, dryRun);
}

/**
 * Entry point for `xinity up infra-redis`. If a working connection already
 * exists, offers to keep it or reconfigure. Otherwise falls through to the
 * normal discovery flow.
 */
export async function infraRedis(host: Host, dryRun: boolean): Promise<string | undefined> {
  const { testRedisConnection } = await import("./connectivity.ts");

  const stored = await readSecrets(host, SECRETS_DIR, ["REDIS_URL"], "Read stored Redis URL");
  if (stored.secrets.REDIS_URL) {
    const url = stored.secrets.REDIS_URL;
    const ok = await testRedisConnection(url, host);

    if (ok) {
      info("Redis connection", `Current: ${redactRedisUrl(url)}`);
      const action = await p.select({
        message: "Redis is configured and reachable.",
        options: [
          { value: "keep", label: "Keep current configuration" },
          { value: "reenter", label: "Enter a different URL" },
          { value: "setup", label: "Set up a new Redis instance" },
        ],
      });
      if (p.isCancel(action) || action === "keep") return url;
      if (action === "reenter") {
        const newUrl = await promptAndValidateRedisUrl(host);
        if (newUrl && !dryRun) await persistRedisUrl(host, newUrl);
        return newUrl;
      }
      // setup: fall through to full setup
      const newUrl = await redisSetup(host, dryRun);
      if (newUrl) {
        await testRedisConnection(newUrl, host);
        if (!dryRun) await persistRedisUrl(host, newUrl);
      }
      return newUrl;
    }

    // Stored but not reachable, delegate to the stale-URL flow in discoverRedisUrl
  }

  return discoverRedisUrl(host, dryRun);
}
