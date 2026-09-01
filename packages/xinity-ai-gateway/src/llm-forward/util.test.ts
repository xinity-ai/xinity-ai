import { describe, test, expect, mock } from "bun:test";
import { MOCK_GATEWAY_ENV } from "./mock-env";

mock.module("../env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

const { classifyStreamError } = await import("./util");

function timeoutError() {
  const error = new Error("timed out");
  error.name = "TimeoutError";
  return error;
}

function connectionRefused() {
  const error = new Error("connect ECONNREFUSED");
  (error as { code?: string }).code = "ConnectionRefused";
  return error;
}

function upstreamError(message: string, status = 400) {
  const error = new Error(message);
  (error as { statusCode?: number }).statusCode = status;
  return error;
}

describe("classifyStreamError", () => {
  test("reports a backend timeout as a warning", () => {
    const info = classifyStreamError(timeoutError());
    expect(info.message).toBe("Backend timed out while generating the response");
    expect(info.errorType).toBe("timeout_error");
    expect(info.logLevel).toBe("warn");
  });

  test("reports an unreachable backend as temporarily unavailable", () => {
    const info = classifyStreamError(connectionRefused());
    expect(info.message).toBe("Service temporarily unavailable");
    expect(info.logLevel).toBe("warn");
  });

  test("passes an upstream message through, since those are meaningful to callers", () => {
    const info = classifyStreamError(upstreamError("context length exceeded"));
    expect(info.message).toBe("context length exceeded");
    expect(info.logLevel).toBe("error");
  });

  test("does not leak the message of an error it does not recognize", () => {
    const info = classifyStreamError(new Error("connect to postgres at 10.0.0.4 failed"));
    expect(info.message).toBe("Internal server error");
    expect(info.message).not.toContain("10.0.0.4");
    expect(info.logLevel).toBe("error");
  });

  test("does not leak details of a non-error throw", () => {
    expect(classifyStreamError("something odd").message).toBe("Internal server error");
  });
});
