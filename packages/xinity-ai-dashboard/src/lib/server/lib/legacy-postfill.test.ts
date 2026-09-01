import { describe, test, expect } from "bun:test";
import { callMessageRows } from "./legacy-postfill";

describe("callMessageRows", () => {
  test("marks the trailing message as the output", () => {
    const rows = callMessageRows("call-1", 2, ["a", "b", "c"]);

    expect(rows.map((row) => row.direction)).toEqual(["input", "input", "output"]);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
  });

  test("marks the only message as the output when the call had no input", () => {
    expect(callMessageRows("call-1", 0, ["a"])).toEqual([
      { callId: "call-1", seq: 0, messageId: "a", direction: "output" },
    ]);
  });
});
