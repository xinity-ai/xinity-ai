#!/usr/bin/env bun
import "zod/compile";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { version } from "../../../package.json";
import { doctorCommand } from "./commands/doctor.ts";
import { upCommand } from "./commands/up.ts";
import { updateCommand, cleanupOldBinary } from "./commands/update.ts";
import { actCommand, preloadActChoices } from "./commands/act.ts";
import { configureCommand } from "./commands/configure.ts";
import { rmCommand } from "./commands/rm.ts";
import { completionCommand } from "./commands/completion.ts";
import { stackCommand } from "./commands/stack.ts";

const LOCAL_LINUX_COMMANDS = new Set(["up", "rm", "doctor"]);

function rejectLocalServiceCommands(argv: { _: (string | number)[]; "target-host"?: string }): void {
  if (process.platform === "linux") {
    return;
  }
  const cmd = String(argv._[0] ?? "");
  if (!LOCAL_LINUX_COMMANDS.has(cmd)) {
    return;
  }
  if (argv["target-host"]) {
    return;
  }
  console.error(
    `Service management requires a Linux host. ` +
    `Use --target-host to specify a remote Linux host.`,
  );
  process.exit(1);
}

async function main() {
  cleanupOldBinary();

  if (process.argv.includes("--get-yargs-completions")) {
    await preloadActChoices();
  }

  await yargs(hideBin(process.argv))
    .scriptName("xinity")
    .version(`v${version}`)
    .middleware(rejectLocalServiceCommands, true)
    .command(doctorCommand)
    .command(upCommand)
    .command(rmCommand)
    .command(updateCommand)
    .command(actCommand)
    .command(configureCommand)
    .command(stackCommand)
    .command(completionCommand)
    .completion("__completions", false)
    .demandCommand(1, "Run xinity --help for available commands")
    .strict()
    .help()
    .parse();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
