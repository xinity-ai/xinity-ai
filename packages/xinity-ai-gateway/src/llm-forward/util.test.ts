import { describe, test, expect } from "bun:test";


const { classifyStreamError, forwardBackendError } = await import("./util");

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

describe("forwardBackendError", () => {
  const route = { model: "llama3:latest", nodeId: "node-1", host: "10.0.0.5:4010", specifier: "llama3:latest", authToken: "t" };

  function capturingLog() {
    const entries: { fields: Record<string, unknown>; msg: string }[] = [];
    return { entries, error: (fields: Record<string, unknown>, msg: string) => entries.push({ fields, msg }) };
  }

  test("reports a daemon signature refusal as a bad gateway, not a client auth failure", async () => {
    const log = capturingLog();
    const res = await forwardBackendError(new Response("Unauthorized: stale", { status: 401 }), log, route);

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("stale");
    expect(log.entries[0]?.msg).toBe("Daemon refused the gateway's request signature");
    expect(log.entries[0]?.fields).toMatchObject({ nodeId: "node-1", host: "10.0.0.5:4010", specifier: "llama3:latest", signed: true, body: "Unauthorized: stale" });
  });

  test("passes other client errors through with the node that produced them logged", async () => {
    const log = capturingLog();
    const body = JSON.stringify({ error: { message: "context length exceeded" } });
    const res = await forwardBackendError(new Response(body, { status: 400 }), log, { ...route, authToken: null });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(body);
    expect(log.entries[0]?.fields).toMatchObject({ nodeId: "node-1", status: 400, signed: false });
  });
});
