import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { configBool, configInt, configList, configNumber, readLeafMeta } from "./leaf-types";

test("each leaf parses the string form an environment supplies", () => {
  expect(configBool().parse("true")).toBe(true);
  expect(configInt().parse("4010")).toBe(4010);
  expect(configInt().parse("-5")).toBe(-5);
  expect(configInt().parse(" 4010 ")).toBe(4010);
  expect(configNumber().parse("0.7")).toBe(0.7);
  expect(configList(z.string()).parse(" a , , b ")).toEqual(["a", "b"]);
});

describe("parsing is strict", () => {
  test("rejects what z.coerce would silently turn into a number", () => {
    for (const input of [null, "", true]) {
      expect(configInt().safeParse(input).success).toBe(false);
      expect(configNumber().safeParse(input).success).toBe(false);
    }
  });

  test("rejects text that is not the number it claims to be", () => {
    expect(configInt().safeParse("abc").success).toBe(false);
    expect(configInt().safeParse("4.5").success).toBe(false);
    expect(configNumber().safeParse("abc").success).toBe(false);
    expect(configBool().safeParse("maybe").success).toBe(false);
  });
});

test("constraints on the base reach the parsed number", () => {
  const port = configInt(z.int().min(1).max(255));
  expect(port.parse("255")).toBe(255);
  expect(port.safeParse("256").success).toBe(false);
  expect(port.safeParse("0").success).toBe(false);
});

test("a list of structured entries parses from delimited pairs", () => {
  const credential = z.object({ user: z.string(), password: z.string() });
  const auth = configList(
    z
      .string()
      .transform((raw) => {
        const [user = "", ...rest] = raw.split(":");
        return { user, password: rest.join(":") };
      })
      .pipe(credential),
  );

  expect(auth.parse("admin:hunter2,prom:a:b")).toEqual([
    { user: "admin", password: "hunter2" },
    { user: "prom", password: "a:b" },
  ]);
});

test("readLeafMeta merges markers through wrappers, outer winning", () => {
  const meta = readLeafMeta(configInt().describe("Listen port").optional().meta({ secret: true }));
  expect(meta.description).toBe("Listen port");
  expect(meta.secret).toBe(true);

  const overridden = z.string().meta({ secret: true }).optional().meta({ secret: false });
  expect(readLeafMeta(overridden).secret).toBe(false);
});
