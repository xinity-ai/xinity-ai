/**
 * Persistent CLI configuration stored at ~/.config/xinity/config.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as p from "./clack.ts";
import pc from "picocolors";

export interface CliConfig {
  apiKey?: string;
  dashboardUrl?: string;
  githubProjectUrl?: string;
  githubToken?: string;
}

/**
 * Maps CliConfig keys to their corresponding environment variable names.
 * Env vars take precedence over config file values.
 */
export const ENV_VAR_MAP: Record<keyof CliConfig, string> = {
  apiKey: "XINITY_API_KEY",
  dashboardUrl: "XINITY_DASHBOARD_URL",
  githubProjectUrl: "XINITY_GITHUB_PROJECT_URL",
  githubToken: "XINITY_GITHUB_TOKEN",
};

/**
 * Resolve a single config value with env-var precedence:
 *   env var → config file → fallback.
 */
export function resolveConfigValue<K extends keyof CliConfig>(
  key: K,
  fallback?: string,
): string | undefined {
  return process.env[ENV_VAR_MAP[key]] ?? loadConfig()[key] ?? fallback;
}

type ConfigKey = keyof CliConfig;

interface ConfigField {
  key: ConfigKey;
  label: string;
  isSecret: boolean;
}

const CLI_FIELDS: ConfigField[] = [
  { key: "apiKey", label: "API key", isSecret: true },
  { key: "dashboardUrl", label: "Dashboard URL", isSecret: false },
  { key: "githubProjectUrl", label: "GitHub project URL", isSecret: false },
  { key: "githubToken", label: "GitHub token (for private repo access)", isSecret: true },
];

const CONFIG_DIR = join(homedir(), ".config", "xinity");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export { CONFIG_PATH };

/** Read the config file, returning an empty object if it doesn't exist. */
export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as CliConfig;
  } catch {
    return {};
  }
}

/** Write the full config object to disk, creating the directory if needed. */
export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/** Merge partial updates into the existing config and persist. */
export function updateConfig(patch: Partial<CliConfig>): CliConfig {
  const config = { ...loadConfig(), ...patch };
  saveConfig(config);
  return config;
}

/** Format a CLI config value for display in the menu. */
function displayCliValue(field: ConfigField, value: string | undefined): string {
  if (value) {
    return field.isSecret ? pc.dim("••••••") : pc.cyan(value);
  }
  return pc.dim("(not set)");
}

/**
 * Menu-based interactive configuration for CLI settings.
 * Shows all fields in a select menu with current values.
 */
export async function menuConfigureCli(): Promise<void> {
  const config = loadConfig();

  p.intro(`xinity configure ${pc.cyan("cli")}`);

  while (true) {
    const options = CLI_FIELDS.map((field) => ({
      value: field.key as string,
      label: `${field.label}  ${displayCliValue(field, config[field.key])}`,
    }));
    options.push({ value: "__save__", label: pc.green("Save & exit") });

    const choice = await p.select({
      message: "Select a value to update",
      options,
    });

    if (p.isCancel(choice)) {
      p.cancel("Cancelled, no changes saved.");
      return;
    }

    if (choice === "__save__") break;

    const field = CLI_FIELDS.find((f) => f.key === choice)!;
    const current = config[field.key];

    if (field.isSecret) {
      const keepHint = current ? pc.dim(" [Enter to keep current]") : "";
      const value = await p.password({
        message: `${field.label}${keepHint}`,
      });
      if (p.isCancel(value)) { p.cancel("Cancelled."); return; }
      if (value) config[field.key] = value;
      else if (!current) delete config[field.key];
    } else {
      const value = await p.text({
        message: field.label,
        placeholder: current ?? undefined,
        defaultValue: current ?? undefined,
      });
      if (p.isCancel(value)) { p.cancel("Cancelled."); return; }
      if (value) config[field.key] = value;
      else delete config[field.key];
    }
  }

  saveConfig(config);
  p.log.success(`Config saved to ${pc.dim(CONFIG_PATH)}`);
  p.outro("Done");
}
