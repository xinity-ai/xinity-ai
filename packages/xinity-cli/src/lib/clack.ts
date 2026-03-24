/**
 * Thin wrappers around @clack/prompts that default output to process.stderr.
 *
 * All UI chrome (spinner, intro, outro, logs, prompts) goes to stderr so that
 * stdout stays clean for pipeable content (`xinity doctor --json | jq`).
 *
 * Usage: `import * as p from "./clack.ts"`, same API as @clack/prompts.
 */
import * as clack from "@clack/prompts";
export type {
  CommonOptions,
  SpinnerOptions,
  SpinnerResult,
  LogMessageOptions,
  SelectOptions,
  ConfirmOptions,
  TextOptions,
  PasswordOptions,
  NoteOptions,
  Option,
} from "@clack/prompts";
export { isCancel } from "@clack/prompts";

const OUT = process.stderr;

export const intro = (title?: string, opts?: clack.CommonOptions) =>
  clack.intro(title, { output: OUT, ...opts });

export const outro = (message?: string, opts?: clack.CommonOptions) =>
  clack.outro(message, { output: OUT, ...opts });

export const cancel = (message?: string, opts?: clack.CommonOptions) =>
  clack.cancel(message, { output: OUT, ...opts });

export const note = (message?: string, title?: string, opts?: clack.NoteOptions) =>
  clack.note(message, title, { output: OUT, ...opts });

export const spinner = (opts?: clack.SpinnerOptions): clack.SpinnerResult =>
  clack.spinner({ output: OUT, ...opts });

export const log = {
  message: (message?: string | string[], opts?: clack.LogMessageOptions) =>
    clack.log.message(message, { output: OUT, ...opts }),
  info: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.info(message, { output: OUT, ...opts }),
  success: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.success(message, { output: OUT, ...opts }),
  step: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.step(message, { output: OUT, ...opts }),
  warn: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.warn(message, { output: OUT, ...opts }),
  warning: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.warning(message, { output: OUT, ...opts }),
  error: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.error(message, { output: OUT, ...opts }),
};

export const select = <Value>(opts: clack.SelectOptions<Value>) =>
  clack.select({ output: OUT, ...opts });

export const confirm = (opts: clack.ConfirmOptions) =>
  clack.confirm({ output: OUT, ...opts });

export const text = (opts: clack.TextOptions) =>
  clack.text({ output: OUT, ...opts });

export const password = (opts: clack.PasswordOptions) =>
  clack.password({ output: OUT, ...opts });
