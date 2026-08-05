import type { CommandModule } from "yargs";
import { cancel, confirm, intro, isCancel, outro } from "../lib/clack.ts";
import { cyan, dim, yellow } from "picocolors";
import { removeComponentCollapsed, removeAll } from "../lib/install-remove.ts";
import type { Component } from "../lib/component-meta.ts";
import { logErrors } from "../lib/output.ts";
import { connectHost, TARGET_HOST_OPTION } from "../lib/remote-host.ts";

const COMPONENTS = ["gateway", "dashboard", "daemon", "infoserver", "tether", "all"] as const;

function buildRemovalConfirmMessage(component: string, purge: boolean, target: string): string {
  if (component === "all") {
    return purge
      ? `Remove ALL Xinity components and permanently delete all state data on ${target}? This cannot be undone.`
      : `Remove ALL Xinity components on ${target}?`;
  }
  return purge
    ? `Remove ${cyan(component)} and permanently delete its state data on ${target}?`
    : `Remove ${cyan(component)} on ${target}?`;
}

export const rmCommand: CommandModule = {
  command: "rm <component>",
  describe: "Remove an installed Xinity service component",
  builder: (yargs) =>
    yargs
      .positional("component", {
        describe: "Component to remove",
        type: "string",
        choices: [...COMPONENTS],
        demandOption: true,
      })
      .option("purge", {
        describe: "Also remove state data (logs, runtime files)",
        type: "boolean",
        default: false,
      })
      .option("target-host", TARGET_HOST_OPTION),
  handler: async (argv) => {
    const component = argv.component as string;
    const purge = argv.purge as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;

    intro(`xinity rm ${cyan(component)}${purge ? yellow(" --purge") : ""}${targetHostArg ? dim(` → ${targetHostArg}`) : ""}`);

    const host = await connectHost(targetHostArg);

    try {
      const target = targetHostArg ? cyan(targetHostArg) : "this machine";
      const confirmed = await confirm({
        message: buildRemovalConfirmMessage(component, purge, target),
        initialValue: false,
      });
      if (isCancel(confirmed) || !confirmed) {
        cancel("Cancelled.");
        return;
      }

      if (!(await host.prepareElevation())) {
        outro("Aborted");
        return;
      }

      if (component === "all") {
        await removeAll(purge, host);
        outro("Done");
        return;
      }

      const result = await removeComponentCollapsed({ component: component as Component, purge, host });

      logErrors(result);
      outro("Done");
    } finally {
      await host.dispose();
    }
  },
};
