import { z } from "zod";

// Strict rather than z.coerce, which turns null into 0. A YAML `port:` with nothing after it is null.
// Surrounding whitespace is still tolerated, since z.coerce accepted it and a hand-edited .env has it.
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

const FILE_FORM = "fileSchema";

// Both branches must declare the same output, or the union widens to unknown and every field
// built from it satisfies any declared type.
function dual<T extends z.ZodType>(native: T, fromString: z.ZodType<z.output<T>, string>) {
  return native.or(fromString).meta({ [FILE_FORM]: native });
}

export function configBool() {
  return dual(z.boolean(), z.stringbool());
}

// Constraints go on `base`: a union has no `.positive()`, and the string branch pipes into that same schema.
export function configInt(base: z.ZodType<number, number> = z.int()) {
  return dual(base, z.string().trim().regex(INTEGER, "must be a whole number").transform(Number).pipe(base));
}

export function configNumber(base: z.ZodType<number, number> = z.number()) {
  return dual(base, z.string().trim().regex(DECIMAL, "must be a number").transform(Number).pipe(base));
}

// `fromEntry` is omittable only for string elements, where `item` already parses one.
export function configList<T extends z.ZodType>(
  item: T,
  fromEntry?: z.ZodType<z.output<T>, string>,
) {
  const entry = (fromEntry ?? item) as z.ZodType<z.output<T>, string>;
  const fromString = z
    .string()
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(entry));
  return dual(z.array(item), fromString);
}

// Only dual leaves record a file form. A plain leaf is its own, which keeps refinements chained on later.
export function fileFormOf(leaf: z.ZodType): z.ZodType {
  const recorded = readLeafMeta(leaf)[FILE_FORM];
  return isSchema(recorded) ? recorded : leaf;
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
