import type { CommandModule } from "yargs";
import * as p from "../lib/clack.ts";
import pc from "picocolors";
import { removeComponent, removeAll, type Component } from "../lib/installer.ts";
import { logErrors } from "../lib/output.ts";
import { createLocalHost } from "../lib/host.ts";
import { connectRemoteHost } from "../lib/remote-host.ts";

const COMPONENTS = ["gateway", "dashboard", "daemon", "infoserver", "all"] as const;

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
      }),
  handler: async (argv) => {
    const component = argv.component as string;
    const purge = argv.purge as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;

    p.intro(`xinity rm ${pc.cyan(component)}${purge ? pc.yellow(" --purge") : ""}${targetHostArg ? pc.dim(` → ${targetHostArg}`) : ""}`);

    const host = targetHostArg ? await connectRemoteHost(targetHostArg) : createLocalHost();

    // Confirm before any destructive removal.
    const target = targetHostArg ? pc.cyan(targetHostArg) : "this machine";
    const confirmMessage =
      component === "all" && purge
        ? `Remove ALL Xinity components and permanently delete all state data on ${target}? This cannot be undone.`
        : component === "all"
          ? `Remove ALL Xinity components on ${target}?`
          : purge
            ? `Remove ${pc.cyan(component)} and permanently delete its state data on ${target}?`
            : `Remove ${pc.cyan(component)} on ${target}?`;

    const confirmed = await p.confirm({ message: confirmMessage, initialValue: false });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled.");
      return;
    }

    if (component === "all") {
      await removeAll(purge, host);
      p.outro("Done");
      return;
    }

    const result = await removeComponent({
      component: component as Component,
      purge,
      host,
    });

    logErrors(result);
    p.outro("Done");
  },
};
