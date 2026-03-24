import { describe, expect, test } from "bun:test";
import { pass, fail, warn, info, heading } from "../../src/lib/output.ts";

/**
 * Output module tests.
 *
 * These functions write to console via @clack/prompts. We verify they
 * don't throw and accept the expected arguments. Since the output is
 * styled for terminal display, we focus on basic invocation correctness.
 */
describe("output", () => {
  test("pass() does not throw", () => {
    expect(() => pass("Test", "detail")).not.toThrow();
  });

  test("pass() works without detail", () => {
    expect(() => pass("Test")).not.toThrow();
  });

  test("fail() does not throw", () => {
    expect(() => fail("Test", "detail")).not.toThrow();
  });

  test("fail() works without detail", () => {
    expect(() => fail("Test")).not.toThrow();
  });

  test("warn() does not throw", () => {
    expect(() => warn("Test", "detail")).not.toThrow();
  });

  test("info() does not throw", () => {
    expect(() => info("Test", "detail")).not.toThrow();
  });

  test("heading() does not throw", () => {
    expect(() => heading("Section Title")).not.toThrow();
  });
});
