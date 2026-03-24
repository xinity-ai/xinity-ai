import type { CommandModule } from "yargs";
import * as p from "../lib/clack.ts";
import pc from "picocolors";
import { runDoctor, type CheckResult, type ComponentReport, type DoctorReport } from "../lib/doctor.ts";
import { createLocalHost } from "../lib/host.ts";
import { connectRemoteHost } from "../lib/remote-host.ts";

// ─── Status symbols ──────────────────────────────────────────────────────────

const SYMBOLS: Record<string, string> = {
  pass: pc.green("✓"),
  fail: pc.red("✗"),
  warn: pc.yellow("⚠"),
  skip: pc.dim("○"),
};

// ─── Report renderer ─────────────────────────────────────────────────────────

const LABEL_WIDTH = 20;
const SEP_WIDTH = 46;

function renderReport(report: DoctorReport, verbose: boolean): void {
  process.stdout.write("\n");

  for (const comp of report.components) {
    renderComponentSection(comp, verbose);
    process.stdout.write("\n");
  }
}

function renderComponentSection(comp: ComponentReport, verbose: boolean): void {
  const name = pc.bold(comp.component.toUpperCase());
  const version = comp.version ? pc.dim(`  v${comp.version}`) : "";
  process.stdout.write(`  ${name}${version}\n`);
  process.stdout.write(`  ${pc.dim("─".repeat(SEP_WIDTH))}\n`);

  for (const check of comp.checks) {
    renderCheckLine(check, verbose);
  }
}

function renderCheckLine(check: CheckResult, verbose: boolean): void {
  const symbol = SYMBOLS[check.status] ?? pc.dim("·");
  const label = check.label.padEnd(LABEL_WIDTH);
  const showDetail = verbose || check.status === "fail" || check.status === "warn";

  process.stdout.write(`  ${symbol}  ${label}${check.message}\n`);

  if (showDetail && check.detail) {
    // Indent detail to align with the message column: 2 + 1 (symbol) + 2 + LABEL_WIDTH
    const indent = " ".repeat(5 + LABEL_WIDTH);
    process.stdout.write(`${indent}${pc.dim(check.detail)}\n`);
  }
}

// ─── Summary line ─────────────────────────────────────────────────────────────

function buildSummaryLine(summary: DoctorReport["summary"]): string {
  return [
    pc.green(`${summary.pass} passed`),
    summary.warn > 0 ? pc.yellow(`${summary.warn} warnings`) : null,
    summary.fail > 0 ? pc.red(`${summary.fail} failed`) : null,
    summary.skip > 0 ? pc.dim(`${summary.skip} skipped`) : null,
  ]
    .filter(Boolean)
    .join(pc.dim(" · "));
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const doctorCommand: CommandModule = {
  command: "doctor",
  describe: "Inspect the running Xinity system and report health status",
  builder: (yargs) =>
    yargs
      .option("verbose", {
        alias: "v",
        describe: "Show detailed output for each check",
        type: "boolean",
        default: false,
      })
      .option("format", {
        alias: "f",
        describe: "Output format",
        choices: ["text", "json", "yaml"] as const,
        default: "text" as const,
      })
      .option("interactive", {
        describe: "Prompt for sudo when permission-denied checks are encountered",
        type: "boolean",
        default: true,
      }),
  handler: async (argv) => {
    const verbose = argv.verbose as boolean;
    const format = argv.format as "text" | "json" | "yaml";
    const interactive = argv.interactive as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;

    p.intro(`xinity doctor${targetHostArg ? pc.dim(` → ${targetHostArg}`) : ""}`);

    const host = targetHostArg ? await connectRemoteHost(targetHostArg) : createLocalHost();

    const clackSpinner = p.spinner();
    clackSpinner.start("Collecting diagnostics…");

    const report = await runDoctor({
      interactive,
      host,
      spinner: {
        message: (msg) => clackSpinner.message(msg),
        stop: () => clackSpinner.stop(""),
      },
    });

    clackSpinner.stop("");

    if (format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(report.summary.fail > 0 ? 1 : 0);
    } else if (format === "yaml") {
      process.stdout.write(Bun.YAML.stringify(report, null, 2));
      process.exit(report.summary.fail > 0 ? 1 : 0);
    } else {
      renderReport(report, verbose);
      p.outro(buildSummaryLine(report.summary));
      if (report.summary.fail > 0) process.exit(1);
    }
  },
};
