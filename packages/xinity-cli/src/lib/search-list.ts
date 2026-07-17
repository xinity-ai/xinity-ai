/**
 * List prompts built on @clack/core's Prompt base, which supplies raw-mode
 * input, frame diffing, and cancel handling; the key model and rendering
 * live here.
 *
 * searchSelect/searchMultiselect have two explicit focus zones: a search bar
 * and the option list. Typing only ever edits the search while it is focused;
 * Down (or Tab) moves focus into the list, where arrows navigate, space
 * toggles (multiselect), and printable keys do nothing. Navigation wraps:
 * Up from the search bar lands on the last row, Down from the last row
 * returns to the search bar.
 *
 * listSelect is a plain wrap-around select in the same visual style.
 *
 * Transient prompts erase themselves after resolving, so menu loops render
 * in place instead of accumulating a line per selection in the scrollback.
 */
import { Prompt } from "@clack/core";
import { cyan, dim, green, inverse, yellow } from "picocolors";

export interface SearchListOption<Value> {
  value: Value;
  label: string;
  hint?: string;
}

interface SharedOptions<Value> {
  message: string;
  options: SearchListOption<Value>[];
  /** Rows visible at once; overflow is windowed with "… n more" markers. */
  maxItems?: number;
  /** Erase the prompt once it resolves instead of leaving a summary line. */
  transient?: boolean;
}

export type SearchSelectOptions<Value> = SharedOptions<Value>;

export type ListSelectOptions<Value> = SharedOptions<Value>;

export interface SearchMultiselectOptions<Value> extends SharedOptions<Value> {
  initialValues?: Value[];
  required?: boolean;
}

const OUT = process.stderr;
const S_BAR = "│";
const S_END = "└";

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

// Transient final frames are exactly one line; one row up plus erase-down
// removes them together with the trailing newline the prompt base emits.
const ERASE_FINAL_FRAME = "\x1b[1A\x1b[J";

async function eraseWhenTransient<T>(result: Promise<T>, transient: boolean | undefined): Promise<T> {
  const value = await result;
  if (transient) {
    OUT.write(ERASE_FINAL_FRAME);
  }
  return value;
}

function listRows<Value>(
  bar: string,
  list: SearchListOption<Value>[],
  cursor: number,
  maxItems: number,
  marker: (option: SearchListOption<Value>, isCursor: boolean) => string,
): string[] {
  const windowStart = Math.max(0, Math.min(
    Math.max(0, cursor) - Math.floor(maxItems / 2),
    list.length - maxItems,
  ));
  const windowEnd = Math.min(list.length, windowStart + maxItems);
  const rows: string[] = [];
  if (windowStart > 0) {
    rows.push(`${bar}  ${dim(`… ${windowStart} more`)}`);
  }
  for (let i = windowStart; i < windowEnd; i++) {
    const option = list[i]!;
    const isCursor = i === cursor;
    const pointer = isCursor ? cyan("❯") : " ";
    const hint = option.hint && isCursor ? ` ${dim(`(${option.hint})`)}` : "";
    rows.push(`${bar}  ${pointer} ${marker(option, isCursor)} ${option.label}${hint}`);
  }
  if (windowEnd < list.length) {
    rows.push(`${bar}  ${dim(`… ${list.length - windowEnd} more`)}`);
  }
  return rows;
}

function run<Value>(opts: {
  message: string;
  options: SearchListOption<Value>[];
  maxItems?: number;
  transient?: boolean;
  multiple: boolean;
  initialValues?: Value[];
  required?: boolean;
}): Promise<Value | Value[] | symbol> {
  const maxItems = Math.max(3, opts.maxItems ?? 12);
  const selected = new Set<Value>(opts.initialValues ?? []);
  let query = "";
  let mode: "search" | "list" = "search";
  let cursor = 0;

  // Filtering runs on every keystroke and render; precompute the searchable
  // text once and reuse one filtered array per query value.
  const searchable = opts.options.map(
    (o) => `${strip(o.label)} ${o.hint ?? ""} ${String(o.value)}`.toLowerCase(),
  );
  let filteredCache = opts.options;
  let filteredForQuery = "";
  const filtered = () => {
    if (query !== filteredForQuery) {
      const q = query.toLowerCase();
      filteredCache = q ? opts.options.filter((_, i) => searchable[i]!.includes(q)) : opts.options;
      filteredForQuery = query;
    }
    return filteredCache;
  };

  const currentValue = () => {
    if (opts.multiple) {
      return [...selected];
    }
    const list = filtered();
    return (mode === "list" ? list[cursor] : list[0])?.value;
  };

  const prompt = new Prompt<Value | Value[]>({
    output: OUT,
    validate: () => {
      if (opts.multiple && opts.required && selected.size === 0) {
        return "Select at least one option (Down to enter the list, space to toggle)";
      }
      if (!opts.multiple && currentValue() === undefined) {
        return "Nothing matches the search";
      }
      return undefined;
    },
    render: () => renderFrame(),
  }, false);

  const sync = () => {
    prompt.value = currentValue();
  };
  sync();

  prompt.on("cursor", (direction) => {
    const list = filtered();
    if (direction === "down" || direction === "right") {
      if (mode === "search") {
        mode = "list";
        cursor = 0;
      } else if (cursor < list.length - 1) {
        cursor++;
      } else {
        mode = "search";
      }
    } else if (direction === "up" || direction === "left") {
      if (mode === "search" && list.length > 0) {
        mode = "list";
        cursor = list.length - 1;
      } else if (mode === "list" && cursor === 0) {
        mode = "search";
      } else if (mode === "list") {
        cursor--;
      }
    } else if (direction === "space" && mode === "list" && opts.multiple) {
      const option = list[cursor];
      if (option) {
        if (selected.has(option.value)) {
          selected.delete(option.value);
        } else {
          selected.add(option.value);
        }
      }
    }
    sync();
  });

  prompt.on("key", (char: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (key?.name === "tab") {
      mode = mode === "search" ? "list" : "search";
      cursor = 0;
      sync();
      return;
    }
    if (mode !== "search") {
      return;
    }
    if (key?.name === "backspace") {
      query = query.slice(0, -1);
      cursor = 0;
      sync();
      return;
    }
    if (char && char.length === 1 && !key?.ctrl && key?.name !== "return" && char >= " ") {
      query += char;
      cursor = 0;
      sync();
    }
  });

  const renderFrame = (): string => {
    const state = prompt.state;
    const list = filtered();

    // Cancel messaging belongs to the caller; announcing it here too would
    // read as two cancellations.
    if (state === "cancel" || state === "submit") {
      if (opts.transient) {
        return dim("◇");
      }
      if (state === "cancel") {
        return `${dim("◇")}  ${opts.message}`;
      }
      const summary = opts.multiple
        ? dim(`${selected.size} selected`)
        : dim(strip(opts.options.find((o) => o.value === currentValue())?.label ?? ""));
      return `${dim("◇")}  ${opts.message}\n${dim(S_BAR)}  ${summary}`;
    }

    const symbol = state === "error" ? yellow("▲") : cyan("◆");
    const bar = state === "error" ? yellow(S_BAR) : cyan(S_BAR);
    const lines: string[] = [`${symbol}  ${opts.message}`];

    const counter = query ? dim(`  ${list.length}/${opts.options.length}`) : "";
    lines.push(mode === "search"
      ? `${bar}  ${cyan("Search:")} ${query}${inverse(" ")}${counter}`
      : `${bar}  ${dim(`Search: ${query || "(Up to focus, then type)"}`)}${counter}`);

    if (list.length === 0) {
      lines.push(`${bar}  ${dim("No matches")}`);
    } else {
      lines.push(...listRows(bar, list, mode === "list" ? cursor : -1, maxItems, (option, isCursor) =>
        opts.multiple
          ? (selected.has(option.value) ? green("◼") : dim("◻"))
          : (isCursor ? green("●") : dim("○")),
      ));
    }

    if (state === "error") {
      lines.push(`${yellow(S_END)}  ${yellow(prompt.error)}`);
    } else {
      lines.push(`${cyan(S_END)}`);
    }
    return lines.join("\n");
  };

  return eraseWhenTransient(
    prompt.prompt() as unknown as Promise<Value | Value[] | symbol>,
    opts.transient,
  );
}

export function searchSelect<Value>(opts: SearchSelectOptions<Value>): Promise<Value | symbol> {
  return run({ ...opts, multiple: false }) as Promise<Value | symbol>;
}

export function searchMultiselect<Value>(opts: SearchMultiselectOptions<Value>): Promise<Value[] | symbol> {
  return run({ ...opts, multiple: true }) as Promise<Value[] | symbol>;
}

export function listSelect<Value>(opts: ListSelectOptions<Value>): Promise<Value | symbol> {
  const maxItems = Math.max(3, opts.maxItems ?? 12);
  let cursor = 0;

  const prompt = new Prompt<Value>({
    output: OUT,
    render: () => {
      const state = prompt.state;
      if (state === "cancel" || state === "submit") {
        if (opts.transient) {
          return dim("◇");
        }
        if (state === "cancel") {
          return `${dim("◇")}  ${opts.message}`;
        }
        const label = strip(opts.options[cursor]?.label ?? "");
        return `${dim("◇")}  ${opts.message}\n${dim(S_BAR)}  ${dim(label)}`;
      }
      return [
        `${cyan("◆")}  ${opts.message}`,
        ...listRows(cyan(S_BAR), opts.options, cursor, maxItems,
          (_, isCursor) => (isCursor ? green("●") : dim("○"))),
        cyan(S_END),
      ].join("\n");
    },
  }, false);

  prompt.on("cursor", (direction) => {
    const last = opts.options.length - 1;
    if (direction === "up" || direction === "left") {
      cursor = cursor === 0 ? last : cursor - 1;
    } else if (direction === "down" || direction === "right") {
      cursor = cursor === last ? 0 : cursor + 1;
    }
    prompt.value = opts.options[cursor]?.value;
  });
  prompt.value = opts.options[cursor]?.value;

  return eraseWhenTransient(prompt.prompt() as unknown as Promise<Value | symbol>, opts.transient);
}
