/**
 * Searchable list prompts with two explicit focus zones: a search bar and
 * the option list. Typing only ever edits the search while it is focused;
 * Down (or Tab) moves focus into the list, where arrows navigate, space
 * toggles (multiselect), and printable keys do nothing. Up from the first
 * row returns to the search bar.
 *
 * Built on @clack/core's Prompt base, which supplies raw-mode input, frame
 * diffing, and cancel handling; the key model and rendering live here.
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
}

export type SearchSelectOptions<Value> = SharedOptions<Value>;

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

function run<Value>(opts: {
  message: string;
  options: SearchListOption<Value>[];
  maxItems?: number;
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
    if (opts.multiple) return [...selected];
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
      }
    } else if (direction === "up" || direction === "left") {
      if (mode === "list" && cursor === 0) {
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
    if (mode !== "search") return;
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
    if (state === "cancel") {
      return `${dim("◇")}  ${opts.message}`;
    }
    if (state === "submit") {
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
      const windowStart = Math.max(0, Math.min(
        (mode === "list" ? cursor : 0) - Math.floor(maxItems / 2),
        list.length - maxItems,
      ));
      const windowEnd = Math.min(list.length, windowStart + maxItems);

      if (windowStart > 0) {
        lines.push(`${bar}  ${dim(`… ${windowStart} more`)}`);
      }
      for (let i = windowStart; i < windowEnd; i++) {
        const option = list[i]!;
        const isCursor = mode === "list" && i === cursor;
        const marker = opts.multiple
          ? (selected.has(option.value) ? green("◼") : dim("◻"))
          : (isCursor ? green("●") : dim("○"));
        const pointer = isCursor ? cyan("❯") : " ";
        const hint = option.hint && isCursor ? ` ${dim(`(${option.hint})`)}` : "";
        lines.push(`${bar}  ${pointer} ${marker} ${option.label}${hint}`);
      }
      if (windowEnd < list.length) {
        lines.push(`${bar}  ${dim(`… ${list.length - windowEnd} more`)}`);
      }
    }

    if (state === "error") {
      lines.push(`${yellow(S_END)}  ${yellow(prompt.error)}`);
    } else {
      lines.push(`${cyan(S_END)}`);
    }
    return lines.join("\n");
  };

  return prompt.prompt() as unknown as Promise<Value | Value[] | symbol>;
}

export function searchSelect<Value>(opts: SearchSelectOptions<Value>): Promise<Value | symbol> {
  return run({ ...opts, multiple: false }) as Promise<Value | symbol>;
}

export function searchMultiselect<Value>(opts: SearchMultiselectOptions<Value>): Promise<Value[] | symbol> {
  return run({ ...opts, multiple: true }) as Promise<Value[] | symbol>;
}
