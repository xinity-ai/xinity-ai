import type { CommandModule } from "yargs";
import { intro, outro, spinner } from "../lib/clack.ts";
import { bold, dim, green, red, yellow } from "picocolors";
import { runDoctor, buildSummaryLine, type CheckResult, type ComponentReport, type DoctorReport } from "../lib/doctor.ts";
import { connectHost, TARGET_HOST_OPTION } from "../lib/remote-host.ts";

// ─── Status symbols ──────────────────────────────────────────────────────────

const SYMBOLS: Record<string, string> = {
  pass: green("✓"),
  fail: red("✗"),
  warn: yellow("⚠"),
  skip: dim("○"),
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
  const name = bold(comp.component.toUpperCase());
  const ver = comp.version?.replace(/^v/, "") ?? null;
  const version = ver ? dim(`  v${ver}`) : "";
  process.stdout.write(`  ${name}${version}\n`);
  process.stdout.write(`  ${dim("─".repeat(SEP_WIDTH))}\n`);

  for (const check of comp.checks) {
    renderCheckLine(check, verbose);
  }
}

function renderCheckLine(check: CheckResult, verbose: boolean): void {
  const symbol = SYMBOLS[check.status] ?? dim("·");
  const label = check.label.padEnd(LABEL_WIDTH);
  const showDetail = verbose || check.status === "fail" || check.status === "warn";

  process.stdout.write(`  ${symbol}  ${label}${check.message}\n`);

  if (showDetail && check.detail) {
    // Indent detail to align with the message column: 2 + 1 (symbol) + 2 + LABEL_WIDTH
    const indent = " ".repeat(5 + LABEL_WIDTH);
    process.stdout.write(`${indent}${dim(check.detail)}\n`);
  }
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
      })
      .option("target-host", TARGET_HOST_OPTION),
  handler: async (argv) => {
    const verbose = argv.verbose as boolean;
    const format = argv.format as "text" | "json" | "yaml";
    const interactive = argv.interactive as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;

    intro(`xinity doctor${targetHostArg ? dim(` → ${targetHostArg}`) : ""}`);

    let host;
    try {
      host = await connectHost(targetHostArg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const report: DoctorReport = {
        timestamp: new Date().toISOString(),
        components: [{
          component: "connection",
          installed: false,
          version: null,
          checks: [{ label: "SSH", status: "fail", message: `Cannot connect to target host: ${msg}` }],
        }],
        summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
      };
      if (format === "json") {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else if (format === "yaml") {
        process.stdout.write(Bun.YAML.stringify(report, null, 2));
      } else {
        renderReport(report, verbose);
        outro(buildSummaryLine(report.summary));
      }
      process.exit(1);
      return;
    }

    let hasFailures = false;
    try {
      const clackSpinner = spinner();
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
      } else if (format === "yaml") {
        process.stdout.write(Bun.YAML.stringify(report, null, 2));
      } else {
        renderReport(report, verbose);
        outro(buildSummaryLine(report.summary));
      }
      hasFailures = report.summary.fail > 0;
    } finally {
      await host.dispose();
    }
    if (hasFailures) process.exit(1);
  },
};
