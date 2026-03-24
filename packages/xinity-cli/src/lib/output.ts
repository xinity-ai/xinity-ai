import * as p from "./clack.ts";
import pc from "picocolors";

export { p as prompts, pc as colors };

export function pass(label: string, detail?: string) {
  p.log.success(`${label}${detail ? ` ${pc.dim("-")} ${pc.dim(detail)}` : ""}`);
}

export function fail(label: string, detail?: string) {
  p.log.error(`${label}${detail ? ` ${pc.dim("-")} ${pc.dim(detail)}` : ""}`);
}

export function warn(label: string, detail?: string) {
  p.log.warn(`${label}${detail ? ` ${pc.dim("-")} ${pc.dim(detail)}` : ""}`);
}

export function info(label: string, detail?: string) {
  p.log.info(`${label}${detail ? ` ${pc.dim("-")} ${pc.dim(detail)}` : ""}`);
}

export function heading(text: string) {
  p.log.step(pc.bold(text));
}

/** Cancel the current prompt flow and exit the process cleanly. */
export function cancelAndExit(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

/** Log all errors from a result object to stderr. */
export function logErrors(result: { success: boolean; errors: string[] }): void {
  if (!result.success && result.errors.length > 0) {
    for (const err of result.errors) {
      p.log.error(err);
    }
  }
}
