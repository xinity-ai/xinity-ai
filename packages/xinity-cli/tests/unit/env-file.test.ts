import { describe, expect, test } from "bun:test";
import { parseEnvString, serializeEnvFile } from "../../src/lib/env-file.ts";

describe("parseEnvString", () => {
  test("parses simple KEY=value lines", () => {
    expect(parseEnvString("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  test("skips blank lines and comments", () => {
    expect(parseEnvString("# comment\n\nA=1\n  # indented\n")).toEqual({ A: "1" });
  });

  test("trims whitespace around the = separator", () => {
    expect(parseEnvString("KEY = value")).toEqual({ KEY: "value" });
  });

  test("strips matching surrounding quotes while preserving inner spaces", () => {
    expect(parseEnvString('A="hello world"')).toEqual({ A: "hello world" });
    expect(parseEnvString("B = ' spaced '")).toEqual({ B: " spaced " });
  });

  test("keeps '=' characters that appear in the value", () => {
    expect(parseEnvString("URL=postgres://u:p@h/db?x=1")).toEqual({
      URL: "postgres://u:p@h/db?x=1",
    });
  });

  test("handles empty values", () => {
    expect(parseEnvString("A=")).toEqual({ A: "" });
  });
});

describe("serializeEnvFile", () => {
  test("round-trips values that need quoting", () => {
    const values = { A: "1", B: "two words", C: "https://x.test" };
    expect(parseEnvString(serializeEnvFile(values))).toEqual(values);
  });
});
