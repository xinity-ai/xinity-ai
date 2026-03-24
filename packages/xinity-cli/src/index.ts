#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { version } from "../../../package.json";
import { doctorCommand } from "./commands/doctor.ts";
import { upCommand } from "./commands/up.ts";
import { updateCommand } from "./commands/update.ts";
import { actCommand, preloadActChoices } from "./commands/act.ts";
import { configureCommand } from "./commands/configure.ts";
import { rmCommand } from "./commands/rm.ts";
import { completionCommand } from "./commands/completion.ts";

// Wrapped in an async function to avoid top-level await, which Bun.build()
// transforms into an internal `awaitPromise` call that breaks the two-step
// bundle → compile build (see build.ts comments).
async function main() {
  // Preload route names so the synchronous yargs builder can offer them as choices.
  if (process.argv.includes("--get-yargs-completions")) {
    await preloadActChoices();
  }

  await yargs(hideBin(process.argv))
    .scriptName("xinity")
    .version(`v${version}`)
    .option("target-host", {
      describe: "SSH host to operate on (any valid ssh bind_address or host alias)",
      type: "string",
      global: true,
    })
    .command(doctorCommand)
    .command(upCommand)
    .command(rmCommand)
    .command(updateCommand)
    .command(actCommand)
    .command(configureCommand)
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
