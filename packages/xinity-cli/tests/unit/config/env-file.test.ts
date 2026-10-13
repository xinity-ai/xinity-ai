import { describe, expect, test } from "bun:test";
import { parseEnvString, serializeEnvFile } from "../../../src/lib/config/env-file.ts";

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

  test("round-trips values containing both quote types", () => {
    const values = { MSG: `she said "it's fine"` };
    const serialized = serializeEnvFile(values);
    expect(parseEnvString(serialized)).toEqual(values);
    expect(parseEnvString(serializeEnvFile(parseEnvString(serialized)))).toEqual(values);
  });
});

describe("backslashes, as systemd's EnvironmentFile reads them", () => {
  test("unescapes only \\\\, \\\", \\` and \\$ inside double quotes", () => {
    expect(parseEnvString(String.raw`A="C:\\x \"q\" \$HOME \d"`)).toEqual({ A: String.raw`C:\x "q" $HOME \d` });
  });

  test("drops the escaping backslash in unquoted values", () => {
    expect(parseEnvString(String.raw`A=^a\.b$`)).toEqual({ A: "^a.b$" });
  });

  test("keeps backslashes literal inside single quotes", () => {
    expect(parseEnvString(String.raw`A='C:\x'`)).toEqual({ A: String.raw`C:\x` });
  });

  test("round-trips values containing backslashes", () => {
    const values = { REGEX: String.raw`^a\.b$`, PATH_LIKE: String.raw`C:\x`, MIXED: String.raw`say "\n" it's` };
    expect(parseEnvString(serializeEnvFile(values))).toEqual(values);
  });
});
