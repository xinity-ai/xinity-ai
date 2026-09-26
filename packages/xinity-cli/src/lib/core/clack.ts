/**
 * Thin wrappers around @clack/prompts that default output to process.stderr.
 *
 * All UI chrome (spinner, intro, outro, logs, prompts) goes to stderr so that
 * stdout stays clean for pipeable content (`xinity doctor --json | jq`).
 *
 * Import the wrappers by name, same API as @clack/prompts.
 */
import * as clack from "@clack/prompts";
export { isCancel } from "@clack/prompts";

const OUT = process.stderr;

const ANSI = /\[[0-9;]*m/g;
/** What log lines sit behind: one symbol and two spaces, on continuation lines too. */
const LOG_GUTTER = 3;

/**
 * Prompts and notes are wrapped by clack itself, log lines are not: it splits on newlines and
 * leaves the overflow to the terminal, which breaks mid-word. Words longer than the line are
 * left alone so a URL stays on one line.
 */
function wrap(message: string): string {
  const max = Math.max(30, (OUT.columns ?? 80) - LOG_GUTTER);
  const width = (text: string) => text.replace(ANSI, "").length;

  return message.split("\n").map((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line === "") {
        line = word;
      } else if (width(line) + 1 + width(word) <= max) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
    return lines.join("\n");
  }).join("\n");
}

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
    clack.log.message(Array.isArray(message) ? message.map(wrap) : message && wrap(message), { output: OUT, ...opts }),
  info: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.info(wrap(message), { output: OUT, ...opts }),
  success: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.success(wrap(message), { output: OUT, ...opts }),
  step: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.step(wrap(message), { output: OUT, ...opts }),
  warn: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.warn(wrap(message), { output: OUT, ...opts }),
  error: (message: string, opts?: clack.LogMessageOptions) =>
    clack.log.error(wrap(message), { output: OUT, ...opts }),
};

export const select = <Value>(opts: clack.SelectOptions<Value>) =>
  clack.select({ output: OUT, ...opts });

export const multiselect = <Value>(opts: clack.MultiSelectOptions<Value>) =>
  clack.multiselect({ output: OUT, ...opts });

export const confirm = (opts: clack.ConfirmOptions) =>
  clack.confirm({ output: OUT, ...opts });

export const text = (opts: clack.TextOptions) =>
  clack.text({ output: OUT, ...opts });

export const password = (opts: clack.PasswordOptions) =>
  clack.password({ output: OUT, ...opts });
