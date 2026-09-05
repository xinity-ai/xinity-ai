import { z } from "zod";

// Strict rather than z.coerce, which turns null and "" into 0.
// Surrounding whitespace is still tolerated, since z.coerce accepted it and a hand-edited .env has it.
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

export function configBool() {
  return z.stringbool();
}

// Constraints go on `base`, which the parsed number is piped into.
export function configInt(base: z.ZodType<number, number> = z.int()) {
  return z.string().trim().regex(INTEGER, "must be a whole number").transform(Number).pipe(base);
}

export function configNumber(base: z.ZodType<number, number> = z.number()) {
  return z.string().trim().regex(DECIMAL, "must be a number").transform(Number).pipe(base);
}

export function configList<T extends z.ZodType<unknown, string>>(entry: T) {
  return z
    .string()
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(entry));
}

/** Reads markers through the `.optional()` and `.default()` wrappers the registry never sees. Outer wins. */
export function readLeafMeta(schema: z.ZodType): Record<string, unknown> {
  const chain: z.ZodType[] = [];
  for (let cursor: z.ZodType | undefined = schema; cursor; cursor = unwrapOnce(cursor)) {
    chain.push(cursor);
  }

  let merged: Record<string, unknown> = {};
  for (const link of chain.reverse()) {
    merged = { ...merged, ...z.globalRegistry.get(link) };
  }
  return merged;
}

function unwrapOnce(schema: z.ZodType): z.ZodType | undefined {
  const unwrap = (schema as { unwrap?: () => unknown }).unwrap;
  if (typeof unwrap !== "function") {
    return undefined;
  }
  const inner = unwrap.call(schema);
  return isSchema(inner) ? inner : undefined;
}

function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}
