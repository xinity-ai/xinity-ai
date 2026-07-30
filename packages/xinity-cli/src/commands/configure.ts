import type { CommandModule } from "yargs";
import { menuConfigureCli, loadConfig, saveConfig, updateConfig } from "../lib/config.ts";
import { configureComponentFlow } from "../lib/up-plan.ts";
import type { Component } from "../lib/component-meta.ts";
import type { CliConfig } from "../lib/config.ts";
import { connectHost, TARGET_HOST_OPTION } from "../lib/remote-host.ts";

const CLI_CONFIG_KEYS = ["apiKey", "dashboardUrl", "githubProjectUrl", "githubToken"] as const;
const COMPONENTS = ["cli", "gateway", "dashboard", "daemon", "infoserver", "tether"] as const;

export const configureCommand: CommandModule = {
  command: "configure [key] [value]",
  describe: "Interactively configure a component or set a CLI config value",
  builder: (yargs) =>
    yargs
      .positional("key", {
        describe: "Config key to set, or component to configure interactively",
        type: "string",
        choices: [...CLI_CONFIG_KEYS, ...COMPONENTS],
        default: "cli",
      })
      .positional("value", {
        describe: "Value to assign to the config key",
        type: "string",
      })
      .option("reset", {
        type: "boolean",
        describe: "Clear the specified config key",
        default: false,
      })
      .option("target-host", TARGET_HOST_OPTION),
  handler: async (argv) => {
    const key = argv.key as string;
    const value = argv.value as string | undefined;
    const reset = argv.reset as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;
    const isConfigKey = (CLI_CONFIG_KEYS as readonly string[]).includes(key);

    if (isConfigKey && reset) {
      const config = loadConfig();
      delete (config as Record<string, unknown>)[key];
      saveConfig(config);
      return;
    }

    if (isConfigKey && value !== undefined) {
      updateConfig({ [key]: value } as Partial<CliConfig>);
      return;
    }

    const component = isConfigKey ? "cli" : key;
    if (component === "cli") {
      await menuConfigureCli();
    } else {
      if (process.platform !== "linux" && !targetHostArg) {
        console.error(
          `Configuring ${component} requires a Linux host. ` +
          `Use --target-host to specify a remote Linux host.`,
        );
        process.exit(1);
      }
      const host = await connectHost(targetHostArg);
      try {
        await configureComponentFlow(component as Component, host);
      } finally {
        await host.dispose();
      }
    }
  },
};
