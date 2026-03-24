/**
 * Interactive PostgreSQL setup assistant for `xinity up db`.
 *
 * Guides the user through detecting, installing, starting, and
 * creating a PostgreSQL database before migrations are applied.
 *
 * All shell operations go through the Host interface so this works
 * identically for local and remote (--target-host) execution.
 */
import { randomBytes } from "crypto";
import * as p from "./clack.ts";
import pc from "picocolors";
import { type Host, commandExistsOn } from "./host.ts";
import { pass, fail, info, warn } from "./output.ts";

// ─── Package-manager definitions ────────────────────────────────────────────

interface PackageManager {
  name: string;
  /** The binary on PATH that indicates this PM is available. */
  bin: string;
  /** Shell command to install PostgreSQL. */
  installCmd: string;
  /** Shell command to start the PostgreSQL service after install. */
  startCmd: string;
  /** True when `sudo -u postgres` is NOT needed (e.g. macOS Homebrew). */
  userIsSuper: boolean;
  /** Optional post-install init step (e.g. Arch needs `initdb`). */
  initCmd?: string;
}

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    name: "apt",
    bin: "apt-get",
    installCmd: "apt-get install -y postgresql",
    startCmd: "systemctl start postgresql",
    userIsSuper: false,
  },
  {
    name: "dnf",
    bin: "dnf",
    installCmd: "dnf install -y postgresql-server postgresql",
    startCmd: "systemctl start postgresql",
    userIsSuper: false,
    initCmd: "postgresql-setup --initdb",
  },
  {
    name: "pacman",
    bin: "pacman",
    installCmd: "pacman -S --noconfirm postgresql",
    startCmd: "systemctl start postgresql",
    userIsSuper: false,
    initCmd:
      "su - postgres -c \"initdb --locale en_US.UTF-8 -D /var/lib/postgres/data\"",
  },
  {
    name: "zypper",
    bin: "zypper",
    installCmd: "zypper install -y postgresql-server postgresql",
    startCmd: "systemctl start postgresql",
    userIsSuper: false,
  },
  {
    name: "brew",
    bin: "brew",
    installCmd: "brew install postgresql@17",
    startCmd: "brew services start postgresql@17",
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

/**
 * Check whether the PostgreSQL server is reachable on the host.
 * Tries `pg_isready` first (most reliable), falls back to systemd.
 */
async function isPostgresRunning(host: Host): Promise<boolean> {
  if (await commandExistsOn(host, "pg_isready")) {
    return (await host.run(["pg_isready", "-q"])).ok;
  }
  // Fallback: try common systemd unit names
  for (const unit of ["postgresql", "postgresql.service"]) {
    const res = await host.run(["systemctl", "is-active", unit]);
    if (res.ok) return true;
  }
  return false;
}

/** Try to start PostgreSQL via the package manager's preferred method. */
async function startPostgres(
  host: Host,
  pm: PackageManager | undefined,
  dryRun: boolean,
): Promise<boolean> {
  const startCmd =
    pm?.name === "brew" ? pm.startCmd : "systemctl start postgresql";

  if (dryRun) {
    info("Dry run", `Would start PostgreSQL: ${pc.dim(startCmd)}`);
    return true;
  }

  if (pm?.name === "brew") {
    // Homebrew services don't need sudo
    const res = await host.run(["sh", "-c", startCmd]);
    if (res.ok) {
      pass("PostgreSQL", "Service started");
      return true;
    }
    fail("PostgreSQL", "Failed to start service");
    return false;
  }

  const result = await host.withElevation(startCmd, "Start PostgreSQL");
  if (result.success) {
    pass("PostgreSQL", "Service started");
    return true;
  }
  if (result.skipped) {
    warn("PostgreSQL", "Skipped starting the service");
  } else {
    fail("PostgreSQL", "Failed to start service");
  }
  return false;
}

/** Create a PostgreSQL user and database, returning the connection URL. */
async function createDatabase(
  host: Host,
  pm: PackageManager | undefined,
  dryRun: boolean,
): Promise<string | undefined> {
  p.log.step(pc.bold("Create a new PostgreSQL database"));

  const dbName = await p.text({
    message: "Database name",
    placeholder: "xinity",
    defaultValue: "xinity",
  });
  if (p.isCancel(dbName)) return undefined;

  const dbUser = await p.text({
    message: "Database user",
    placeholder: "xinity",
    defaultValue: "xinity",
  });
  if (p.isCancel(dbUser)) return undefined;

  const useGenerated = await p.confirm({
    message: "Generate a random password?",
    initialValue: true,
  });
  if (p.isCancel(useGenerated)) return undefined;

  let dbPassword: string;
  if (useGenerated) {
    dbPassword = generatePassword();
    info("Password", `Generated: ${pc.cyan(dbPassword)}`);
  } else {
    const pw = await p.password({
      message: "Database password",
      validate: (val) => {
        if (!val || val.length < 4) return "Password must be at least 4 characters";
        return undefined;
      },
    });
    if (p.isCancel(pw)) return undefined;
    dbPassword = pw;
  }

  const connectionUrl = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@localhost:5432/${encodeURIComponent(dbName)}`;

  if (dryRun) {
    info("Dry run", `Would create user ${pc.cyan(dbUser)} and database ${pc.cyan(dbName)}`);
    p.note(connectionUrl, "Connection URL (not yet created)");
    return connectionUrl;
  }

  // Build SQL commands
  const escapedPassword = dbPassword.replace(/'/g, "''");
  const createUserSql = `CREATE USER "${dbUser}" WITH PASSWORD '${escapedPassword}';`;
  const createDbSql = `CREATE DATABASE "${dbName}" OWNER "${dbUser}";`;

  const spinner = p.spinner();

  if (pm?.userIsSuper) {
    // macOS Homebrew: current user is the superuser
    spinner.start("Creating user and database…");
    const userRes = await host.run(["psql", "-d", "postgres", "-c", createUserSql]);
    if (!userRes.ok && !userRes.output.includes("already exists")) {
      spinner.stop("Failed");
      fail("Create user", userRes.output);
      return undefined;
    }
    const dbRes = await host.run(["psql", "-d", "postgres", "-c", createDbSql]);
    if (!dbRes.ok && !dbRes.output.includes("already exists")) {
      spinner.stop("Failed");
      fail("Create database", dbRes.output);
      return undefined;
    }
    spinner.stop("Database created");
  } else {
    // Linux: use sudo -u postgres
    p.log.step("Creating user and database requires access to the postgres system user.");

    const result = await host.withElevation(
      `su - postgres -c "psql -c ${shellQuote(createUserSql)}" && su - postgres -c "psql -c ${shellQuote(createDbSql)}"`,
      "Create PostgreSQL user and database",
    );
    if (!result.success) {
      if (result.skipped) {
        warn("Database", "Skipped database creation");
        return undefined;
      } else if (result.output.includes("already exists")) {
        pass("Database", `${pc.cyan(dbName)} already exists`);
      } else {
        fail("Database", "Failed to create user/database");
        return undefined;
      }
    } else {
      pass("Database", `Created ${pc.cyan(dbName)} owned by ${pc.cyan(dbUser)}`);
    }
  }

  p.note(connectionUrl, "Connection URL");

  return connectionUrl;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Install flow ───────────────────────────────────────────────────────────

async function installPostgres(
  host: Host,
  pm: PackageManager,
  dryRun: boolean,
): Promise<boolean> {
  const proceed = await p.confirm({
    message: `Install PostgreSQL using ${pc.cyan(pm.name)}?`,
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) return false;

  if (dryRun) {
    let desc = pm.installCmd;
    if (pm.initCmd) desc += ` && ${pm.initCmd}`;
    info("Dry run", `Would install PostgreSQL: ${pc.dim(desc)}`);
    return true;
  }

  if (pm.name === "brew") {
    const spinner = p.spinner();
    spinner.start("Installing PostgreSQL via Homebrew…");
    const res = await host.run(["sh", "-c", pm.installCmd]);
    if (!res.ok) {
      spinner.stop("Failed");
      fail("Install", res.output);
      return false;
    }
    spinner.stop("PostgreSQL installed");
    pass("Install", "PostgreSQL installed via Homebrew");
    return true;
  }

  // Linux: needs sudo
  let cmd = pm.installCmd;
  if (pm.initCmd) {
    cmd += ` && ${pm.initCmd}`;
  }

  const result = await host.withElevation(cmd, "Install PostgreSQL");
  if (result.success) {
    pass("Install", "PostgreSQL installed");
    return true;
  }
  if (result.skipped) {
    warn("Install", "Skipped installation");
  } else {
    fail("Install", "Installation failed");
  }
  return false;
}

async function waitForManualInstall(host: Host): Promise<boolean> {
  p.note(
    [
      "Please install PostgreSQL using your system's package manager.",
      "Common commands:",
      "",
      `  ${pc.dim("# Debian/Ubuntu")}`,
      `  sudo apt install postgresql`,
      "",
      `  ${pc.dim("# Fedora/RHEL")}`,
      `  sudo dnf install postgresql-server`,
      "",
      `  ${pc.dim("# Arch Linux")}`,
      `  sudo pacman -S postgresql`,
      "",
      `  ${pc.dim("# macOS")}`,
      `  brew install postgresql@17`,
      "",
      "After installing, make sure the service is running.",
    ].join("\n"),
    "Manual installation required",
  );

  const done = await p.confirm({
    message: "Have you installed and started PostgreSQL?",
    initialValue: false,
  });

  if (p.isCancel(done) || !done) return false;

  // Verify it's actually running now
  if (await isPostgresRunning(host)) {
    pass("PostgreSQL", "Service is running");
    return true;
  }

  warn("PostgreSQL", "Service does not appear to be running yet");
  const continueAnyway = await p.confirm({
    message: "Continue anyway?",
    initialValue: false,
  });
  return !p.isCancel(continueAnyway) && continueAnyway;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Interactive PostgreSQL setup flow.
 *
 * Returns a connection URL if the user went through setup,
 * or `undefined` if they cancelled.
 */
export async function postgresSetup(host: Host, dryRun: boolean): Promise<string | undefined> {
  p.log.step(pc.bold("PostgreSQL setup"));

  // Step 1: Is PostgreSQL installed?
  const hasPostgres =
    (await commandExistsOn(host, "psql")) || (await commandExistsOn(host, "pg_isready"));

  if (!hasPostgres) {
    info("PostgreSQL", "Not found on this system");

    const pm = await detectPackageManager(host);
    if (pm) {
      info("Package manager", `Detected ${pc.cyan(pm.name)}`);
      const installed = await installPostgres(host, pm, dryRun);
      if (!installed) {
        return undefined;
      }

      // Start the service after install
      const started = await startPostgres(host, pm, dryRun);
      if (!started) return undefined;

      return createDatabase(host, pm, dryRun);
    }

    // Unknown package manager
    warn("Package manager", "Could not detect a supported package manager");
    if (dryRun) {
      info("Dry run", "Would ask user to install PostgreSQL manually");
      return createDatabase(host, undefined, dryRun);
    }
    const ready = await waitForManualInstall(host);
    if (!ready) return undefined;

    return createDatabase(host, undefined, dryRun);
  }

  // Step 2: PostgreSQL is installed, is it running?
  if (await isPostgresRunning(host)) {
    pass("PostgreSQL", "Installed and running");
    return createDatabase(host, await detectPackageManager(host), dryRun);
  }

  // Installed but not running
  warn("PostgreSQL", "Installed but not running");

  const pm = await detectPackageManager(host);
  const started = await startPostgres(host, pm, dryRun);
  if (!started) return undefined;

  return createDatabase(host, pm, dryRun);
}
