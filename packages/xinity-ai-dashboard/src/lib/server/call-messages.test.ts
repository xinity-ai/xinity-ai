import { describe, test, expect } from "bun:test";
import { groupCallMessages, type CallMessageRow } from "./call-messages";
import type { ApiCallInputMessage } from "common-db";

const message = (content: string, role: ApiCallInputMessage["role"] = "user") =>
  ({ role, content }) as ApiCallInputMessage;

const row = (
  callId: string,
  direction: "input" | "output",
  content: string,
): CallMessageRow => ({
  callId,
  direction,
  payload: message(content, direction === "output" ? "assistant" : "user"),
});

describe("groupCallMessages", () => {
  test("keeps the conversation in the order the rows arrived", () => {
    const grouped = groupCallMessages([
      row("call-1", "input", "u1"),
      row("call-1", "input", "a1"),
      row("call-1", "input", "u2"),
    ]);

    expect(grouped.get("call-1")?.inputMessages.map((m) => m.content)).toEqual(["u1", "a1", "u2"]);
  });

  test("separates the answer from the question it answered", () => {
    const grouped = groupCallMessages([
      row("call-1", "input", "u1"),
      row("call-1", "output", "a1"),
    ]);

    const call = grouped.get("call-1");
    expect(call?.inputMessages.map((m) => m.content)).toEqual(["u1"]);
    expect(call?.outputMessage?.content).toBe("a1");
  });

  test("keeps one call's conversation out of another's", () => {
    const grouped = groupCallMessages([
      row("call-1", "input", "first question"),
      row("call-1", "output", "first answer"),
      row("call-2", "input", "second question"),
      row("call-2", "output", "second answer"),
    ]);

    expect(grouped.get("call-1")?.inputMessages.map((m) => m.content)).toEqual(["first question"]);
    expect(grouped.get("call-2")?.inputMessages.map((m) => m.content)).toEqual(["second question"]);
    expect(grouped.get("call-2")?.outputMessage?.content).toBe("second answer");
  });

  test("reports no answer for a call that never produced one", () => {
    const grouped = groupCallMessages([row("call-1", "input", "u1")]);

    expect(grouped.get("call-1")?.outputMessage).toBeNull();
  });
});
