import * as p from "./clack.ts";
import pc from "picocolors";

function formatLabelDetail(label: string, detail?: string): string {
  if (!detail) return label;
  return `${label} ${pc.dim("-")} ${pc.dim(detail)}`;
}

export function pass(label: string, detail?: string) {
  p.log.success(formatLabelDetail(label, detail));
}

export function fail(label: string, detail?: string) {
  p.log.error(formatLabelDetail(label, detail));
}

export function warn(label: string, detail?: string) {
  p.log.warn(formatLabelDetail(label, detail));
}

export function info(label: string, detail?: string) {
  p.log.info(formatLabelDetail(label, detail));
}

export function heading(text: string) {
  p.log.step(pc.bold(text));
}

/** Cancel the current prompt flow and exit the process cleanly. */
export function cancelAndExit(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

/**
 * Awaits a clack prompt and exits cleanly if the user cancelled.
 * Returns the prompt result with the cancel symbol narrowed out.
 */
export async function promptOrExit<T>(prompt: Promise<T | symbol>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) cancelAndExit();
  return value as Exclude<T, symbol>;
}

/**
 * Awaits a clack prompt and returns undefined if the user cancelled.
 * Use this when the surrounding setup flow returns undefined to its caller on cancel,
 * rather than tearing down the whole CLI process.
 */
export async function promptOrUndefined<T>(prompt: Promise<T | symbol>): Promise<Exclude<T, symbol> | undefined> {
  const value = await prompt;
  if (p.isCancel(value)) return undefined;
  return value as Exclude<T, symbol>;
}

/** Log all errors from a result object to stderr. */
export function logErrors(result: { success: boolean; errors: string[] }): void {
  if (!result.success && result.errors.length > 0) {
    for (const err of result.errors) {
      p.log.error(err);
    }
  }
}

/**
 * Reports a hard elevation failure and returns true so the caller can short-circuit.
 * A "hard failure" excludes the user-chose-to-skip case, which the caller handles separately if relevant.
 */
export function elevationHardFailed(
  result: { success: boolean; skipped: boolean; output: string },
  label: string,
): boolean {
  if (result.success || result.skipped) return false;
  fail(label, result.output);
  return true;
}

/**
 * Reports a three-way elevation outcome (success/skipped/failed) with the appropriate log level.
 * Returns true on success, false otherwise.
 */
export function reportElevationOutcome(
  result: { success: boolean; skipped: boolean },
  label: string,
  messages: { success: string; skipped: string; failed: string },
): boolean {
  if (result.success) {
    pass(label, messages.success);
    return true;
  }
  if (result.skipped) {
    warn(label, messages.skipped);
  } else {
    fail(label, messages.failed);
  }
  return false;
}
