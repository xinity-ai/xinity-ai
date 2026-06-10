import { describe, test, expect, mock, beforeAll, afterAll, jest, afterEach } from "bun:test";

mock.module("../../env", () => ({
  env: {
    HOST: "localhost",
    PORT: 4010,
    DB_CONNECTION_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    WEB_SEARCH_ENGINE_URL: undefined,
    RESPONSE_CACHE_TTL_SECONDS: 3600,
    INFOSERVER_URL: "http://localhost:3000",
    INFOSERVER_CACHE_TTL_MS: 30000,
    LOAD_BALANCE_STRATEGY: "random",
    BACKEND_TIMEOUT_MS: 300000,
    LOG_LEVEL: "info",
    LOG_DIR: undefined,
    METRICS_AUTH: undefined,
  },
}));

import type { checkAuth as checkAuthT } from "../auth";
import type { getModelInfo as getModelInfoT } from "../model-data";

const checkAuth = jest.fn<typeof checkAuthT>(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
  collectData: true,
}));
mock.module("../auth", () => ({ checkAuth }));

let mockPort = 0;
const transcriptionModel = () => ({
  host: `localhost:${mockPort}`,
  model: "whisper-backend",
  driver: "vllm",
  authToken: null,
  tls: false,
  type: "transcription",
  tags: [],
  requestParams: {},
  release: () => {},
});
const getModelInfo = jest.fn<typeof getModelInfoT>(async () => transcriptionModel());
mock.module("../model-data", () => ({ getModelInfo }));

mock.module("../backend-fetch", () => ({
  backendUrl: (host: string, _model: string, path: string) => `http://${host}${path}`,
  backendFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
  backendPostForm: (target: { host: string }, path: string, form: FormData, signal: AbortSignal) =>
    fetch(`http://${target.host}${path}`, { method: "POST", body: form, signal }),
  hasCustomCa: false,
}));

mock.module("../../callLogger", () => ({
  logChatStream: mock(() => Promise.resolve()),
  logChatSync: mock(() => Promise.resolve()),
}));
mock.module("../../usageRecorder", () => ({ recordUsageEvent: mock(() => {}) }));

const { handleTranscription } = await import("./handle-transcription");

let server: any;
let lastForm: { model: unknown; hasFile: boolean; stream: unknown; language: unknown } | null = null;
let nextResponse: Response | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/audio/transcriptions") {
        if (nextResponse) {
          const r = nextResponse;
          nextResponse = null;
          return r;
        }
        const form = await req.formData();
        lastForm = { model: form.get("model"), hasFile: form.get("file") instanceof Blob, stream: form.get("stream"), language: form.get("language") };
        if (form.get("stream") === "true") {
          // vLLM streams chat-completion-style `transcription.chunk` SSE.
          const sse = [
            'data: {"id":"trsc-1","object":"transcription.chunk","created":1,"model":"whisper-backend","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
            'data: {"id":"trsc-1","object":"transcription.chunk","created":1,"model":"whisper-backend","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
            "data: [DONE]\n\n",
          ].join("");
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json({ text: "hello world" });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  mockPort = server.port;
});
afterEach(() => {
  checkAuth.mockClear();
  getModelInfo.mockClear();
  lastForm = null;
  nextResponse = null;
});
afterAll(() => server.stop());

function makeReq(fields: Record<string, string>, withFile = true): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (withFile) form.append("file", new Blob(["fake-audio"], { type: "audio/wav" }), "audio.wav");
  return new Request("http://localhost:4000/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer test" },
    body: form,
  });
}

describe("handleTranscription", () => {
  test("forwards the multipart form and returns the transcription", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper" }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.text).toBe("hello world");
    expect(lastForm?.model).toBe("whisper-backend");
    expect(lastForm?.hasFile).toBe(true);
  });

  test("translates a vLLM transcription stream into OpenAI events", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper", stream: "true" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(lastForm?.stream).toBe("true");

    const text = await res.text();
    expect(text).toContain('"type":"transcript.text.delta"');
    expect(text).toContain('"delta":"Hello"');
    expect(text).toContain('"type":"transcript.text.done"');
    expect(text).toContain('"text":"Hello world"');
    expect(text).toContain('"input_tokens":5');
    expect(text).not.toContain("transcription.chunk");
  });

  test("emits transcript.text.done without usage when the backend sends none, and ends without a [DONE] sentinel", async () => {
    nextResponse = new Response(
      'data: {"id":"t","object":"transcription.chunk","created":1,"model":"m","choices":[{"delta":{"content":"Hi there"},"finish_reason":"stop"}]}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const res = await handleTranscription(makeReq({ model: "whisper", stream: "true" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"transcript.text.done"');
    expect(text).toContain('"text":"Hi there"');
    expect(text).not.toContain('"usage"');
    expect(text).not.toContain('"input_tokens"');
  });

  test("skips empty/role-only chunks so no spurious delta event is emitted", async () => {
    nextResponse = new Response(
      [
        'data: {"id":"t","object":"transcription.chunk","created":1,"model":"m","choices":[{"delta":{},"finish_reason":null}]}\n\n',
        'data: {"id":"t","object":"transcription.chunk","created":1,"model":"m","choices":[{"delta":{"content":"Solo"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const res = await handleTranscription(makeReq({ model: "whisper", stream: "true" }));
    const text = await res.text();
    expect(text.split('"type":"transcript.text.delta"').length - 1).toBe(1);
    expect(text).toContain('"text":"Solo"');
  });

  test("skips a malformed chunk and still completes the stream", async () => {
    nextResponse = new Response(
      [
        "data: not-json\n\n",
        'data: {"id":"t","object":"transcription.chunk","created":1,"model":"m","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const res = await handleTranscription(makeReq({ model: "whisper", stream: "true" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"delta":"OK"');
    expect(text).toContain('"type":"transcript.text.done"');
  });

  test("forwards non-model form fields (language) to the backend", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper", language: "es" }));
    expect(res.status).toBe(200);
    expect(lastForm?.language).toBe("es");
  });

  test("rejects a non-transcription model type with 400", async () => {
    getModelInfo.mockImplementationOnce(async () => ({ ...transcriptionModel(), type: "chat" }));
    const res = await handleTranscription(makeReq({ model: "gpt" }));
    expect(res.status).toBe(400);
  });

  test("returns 400 when the file is missing", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper" }, false));
    expect(res.status).toBe(400);
  });

  test("returns 400 when the model is missing", async () => {
    const res = await handleTranscription(makeReq({}, true));
    expect(res.status).toBe(400);
  });

  test("returns 404 when the model is not found", async () => {
    getModelInfo.mockImplementationOnce(async () => undefined);
    const res = await handleTranscription(makeReq({ model: "nope" }));
    expect(res.status).toBe(404);
  });

  test("maps a backend 5xx to 502", async () => {
    nextResponse = new Response("boom", { status: 500 });
    const res = await handleTranscription(makeReq({ model: "whisper" }));
    expect(res.status).toBe(502);
  });
});
