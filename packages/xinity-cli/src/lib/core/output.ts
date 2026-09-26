import { cancel, isCancel, log } from "./clack.ts";
import { bgCyan, black, dim } from "picocolors";

function formatLabelDetail(label: string, detail?: string): string {
  if (!detail) return label;
  return `${label} ${dim("-")} ${dim(detail)}`;
}

export function pass(label: string, detail?: string) {
  log.success(formatLabelDetail(label, detail));
}

export function fail(label: string, detail?: string) {
  log.error(formatLabelDetail(label, detail));
}

export function warn(label: string, detail?: string) {
  log.warn(formatLabelDetail(label, detail));
}

export function info(label: string, detail?: string) {
  log.info(formatLabelDetail(label, detail));
}

/** Section header rendered as a colored badge. */
export function heading(text: string) {
  log.step(bgCyan(black(` ${text} `)));
}

/** Cancel the current prompt flow and exit the process cleanly. */
export function cancelAndExit(): never {
  cancel("Cancelled.");
  process.exit(0);
}

/**
 * Awaits a clack prompt and exits cleanly if the user cancelled.
 * Returns the prompt result with the cancel symbol narrowed out.
 */
export async function promptOrExit<T>(prompt: Promise<T | symbol>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (isCancel(value)) cancelAndExit();
  return value as Exclude<T, symbol>;
}

/**
 * Awaits a clack prompt and returns undefined if the user cancelled.
 * Use this when the surrounding setup flow returns undefined to its caller on cancel,
 * rather than tearing down the whole CLI process.
 */
export async function promptOrUndefined<T>(prompt: Promise<T | symbol>): Promise<Exclude<T, symbol> | undefined> {
  const value = await prompt;
  if (isCancel(value)) return undefined;
  return value as Exclude<T, symbol>;
}

/** Log all errors from a result object to stderr. */
export function logErrors(result: { success: boolean; errors: string[] }): void {
  if (!result.success && result.errors.length > 0) {
    for (const err of result.errors) {
      log.error(err);
    }
  }
}

/** Reports a failed elevation result and returns true so the caller can short-circuit. */
export function elevationHardFailed(
  result: { success: boolean; output: string },
  label: string,
): boolean {
  if (result.success) return false;
  fail(label, result.output);
  return true;
}

/** Reports an elevation outcome with the appropriate log level. Returns true on success. */
export function reportElevationOutcome(
  result: { success: boolean },
  label: string,
  messages: { success: string; failed: string },
): boolean {
  if (result.success) {
    pass(label, messages.success);
    return true;
  }
  fail(label, messages.failed);
  return false;
}
