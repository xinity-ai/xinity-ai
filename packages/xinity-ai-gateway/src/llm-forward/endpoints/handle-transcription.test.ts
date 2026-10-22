import { describe, test, expect, mock, beforeAll, afterAll, jest, afterEach } from "bun:test";
import { mockBackendFetch, modelFound } from "./test-helpers";


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
  installationId: "inst-1",
  nodeId: "node-1",
  host: `localhost:${mockPort}`,
  specifier: "whisper-backend",
  model: "whisper-backend",
  driver: "vllm",
  authToken: null,
  tls: false,
  type: "transcription",
  tags: [],
  requestParams: {},
  maxContextLength: 131072,
  release: () => {},
});
const getModelInfo = jest.fn<typeof getModelInfoT>(async () => modelFound(transcriptionModel()));
mock.module("../model-data", () => ({ getModelInfo }));

mockBackendFetch();

mock.module("../../callLogger", () => ({
  logChatStream: mock(() => Promise.resolve()),
  logChatSync: mock(() => Promise.resolve()),
}));
const recordUsageEvent = mock((_event: { inputTokens: number; outputTokens: number; success?: boolean }) => {});
mock.module("../../usageRecorder", () => ({ recordUsageEvent }));

const failedRequests = () => recordUsageEvent.mock.calls.filter(([e]) => e.success === false);

const { handleTranscription } = await import("./handle-transcription");

let server: any;
let lastForm: { model: unknown; hasFile: boolean; stream: unknown; language: unknown; responseFormat: unknown } | null = null;
let nextResponse: Response | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/audio/transcriptions") {
        const form = await req.formData();
        lastForm = { model: form.get("model"), hasFile: form.get("file") instanceof Blob, stream: form.get("stream"), language: form.get("language"), responseFormat: form.get("response_format") };
        if (nextResponse) {
          const r = nextResponse;
          nextResponse = null;
          return r;
        }
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
  recordUsageEvent.mockClear();
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

  test("records usage from a streamed transcription", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper", stream: "true" }));
    await res.text(); // drain the stream so its usage callback fires
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    const event = recordUsageEvent.mock.calls[0]![0];
    expect(event.inputTokens).toBe(5);
    expect(event.outputTokens).toBe(2);
  });

  test("records usage from a non-streamed transcription when the backend reports it", async () => {
    nextResponse = Response.json({ text: "hi", usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    await handleTranscription(makeReq({ model: "whisper" }));
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    const event = recordUsageEvent.mock.calls[0]![0];
    expect(event.inputTokens).toBe(3);
    expect(event.outputTokens).toBe(4);
  });

  test("records a zero-token usage event when the backend reports usage in audio seconds", async () => {
    nextResponse = Response.json({ text: "hi", usage: { type: "duration", seconds: 15 } });
    await handleTranscription(makeReq({ model: "whisper" }));
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({ inputTokens: 0, outputTokens: 0, success: true });
  });

  test("records a zero-token usage event for a plain text transcription", async () => {
    nextResponse = new Response("hi", { headers: { "Content-Type": "text/plain" } });
    await handleTranscription(makeReq({ model: "whisper", response_format: "text" }));
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({ inputTokens: 0, outputTokens: 0, success: true });
  });

  test("forwards non-model form fields (language) to the backend", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper", language: "es" }));
    expect(res.status).toBe(200);
    expect(lastForm?.language).toBe("es");
  });

  test("rejects a non-transcription model type with 400", async () => {
    getModelInfo.mockImplementationOnce(async () => modelFound({ ...transcriptionModel(), type: "chat" }));
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

  test("maps a backend 5xx to 502", async () => {
    nextResponse = new Response("boom", { status: 500 });
    const res = await handleTranscription(makeReq({ model: "whisper" }));
    expect(res.status).toBe(502);
  });

  test("records a failed request when the backend returns 5xx", async () => {
    nextResponse = new Response("boom", { status: 500 });
    await handleTranscription(makeReq({ model: "whisper" }));
    expect(failedRequests()).toHaveLength(1);
  });

  test("records a failed request for a non-transcription model type", async () => {
    getModelInfo.mockImplementationOnce(async () => modelFound({ ...transcriptionModel(), type: "chat" }));
    await handleTranscription(makeReq({ model: "gpt" }));
    expect(failedRequests()).toHaveLength(1);
  });

  test("reports a stream that ends without a terminal chunk as failed, to the client and in usage", async () => {
    nextResponse = new Response(
      'data: {"id":"t","object":"transcription.chunk","created":1,"model":"m","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const res = await handleTranscription(makeReq({ model: "whisper", stream: "true" }));
    const text = await res.text();
    expect(text).not.toContain("transcript.text.done");
    expect(text).toEndWith(`data: ${JSON.stringify({ error: { message: "Backend stream ended before the response was complete", type: "server_error" } })}\n\ndata: [DONE]\n\n`);
    expect(failedRequests()).toHaveLength(1);
  });

  test("does not record a failed request before a node is leased", async () => {
    getModelInfo.mockImplementationOnce(async () => ({ status: "unknown" }));
    const res = await handleTranscription(makeReq({ model: "nope" }));
    expect(res.status).toBe(404);
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });

  test("answers 503 without recording a failed request when the model has no ready hosts", async () => {
    getModelInfo.mockImplementationOnce(async () => ({ status: "unavailable" }));
    const res = await handleTranscription(makeReq({ model: "whisper" }));
    expect(res.status).toBe(503);
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });
});

describe("diarized transcriptions", () => {
  const diarizingModel = () => modelFound({ ...transcriptionModel(), tags: ["diarization"] });
  const chunks = (contents: string[]) => new Response(
    contents.map((content, index) => `data: ${JSON.stringify({
      id: "t", object: "transcription.chunk", created: 1, model: "moss",
      choices: [{ delta: { content }, finish_reason: index === contents.length - 1 ? "stop" : null }],
    })}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const events = async (res: Response) => (await res.text()).split("\n\n").filter(Boolean).map((line) => JSON.parse(line.slice("data: ".length)));

  test("labels speakers A, B, ... in the order they first speak, as OpenAI does", async () => {
    getModelInfo.mockImplementationOnce(async () => diarizingModel());
    nextResponse = Response.json({
      task: "transcribe", duration: 4, text: "Hi Hello Bye",
      segments: [
        { type: "transcript.text.segment", id: "seg_0", start: 0, end: 1, text: "Hi", speaker: "S02" },
        { type: "transcript.text.segment", id: "seg_1", start: 1, end: 2, text: "Hello", speaker: "S01" },
        { type: "transcript.text.segment", id: "seg_2", start: 2, end: 3, text: "Bye", speaker: "S02" },
      ],
    });
    const res = await handleTranscription(makeReq({ model: "moss", response_format: "diarized_json" }));
    const body = await res.json() as { segments: { speaker: string }[] };
    expect(body.segments.map(({ speaker }) => speaker)).toEqual(["A", "B", "A"]);
    expect(lastForm?.responseFormat).toBe("diarized_json");
  });

  test("streams segments and their deltas from the model's speaker markup, however the chunks split it", async () => {
    getModelInfo.mockImplementationOnce(async () => diarizingModel());
    nextResponse = chunks(["[0.48][S0", "1]Welcome every", "one[1.66][12.26][S02]The new", " pipeline[15.", "0]"]);
    const res = await handleTranscription(makeReq({ model: "moss", response_format: "diarized_json", stream: "true" }));
    const sent = await events(res);
    expect(lastForm?.responseFormat).toBe("json");
    expect(sent.filter(({ type }) => type === "transcript.text.segment")).toEqual([
      { type: "transcript.text.segment", id: "seg_0", start: 0.48, end: 1.66, text: "Welcome everyone", speaker: "A" },
      { type: "transcript.text.segment", id: "seg_1", start: 12.26, end: 15, text: "The new pipeline", speaker: "B" },
    ]);
    const deltas = sent.filter(({ type }) => type === "transcript.text.delta");
    expect(deltas.map(({ delta }) => delta).join("")).toBe("Welcome everyone The new pipeline");
    expect(new Set(deltas.map(({ segment_id }) => segment_id))).toEqual(new Set(["seg_0", "seg_1"]));
    expect(sent.at(-1)).toMatchObject({ type: "transcript.text.done", text: "Welcome everyone The new pipeline" });
  });

  test("refuses diarized_json for a model that does not label speakers", async () => {
    const res = await handleTranscription(makeReq({ model: "whisper", response_format: "diarized_json" }));
    expect(res.status).toBe(400);
    expect(lastForm).toBeNull();
  });

  test.each(["known_speaker_names", "known_speaker_names[]", "known_speaker_references[]"])("refuses %s, which no model can match voices against", async (field) => {
    getModelInfo.mockImplementationOnce(async () => diarizingModel());
    const res = await handleTranscription(makeReq({ model: "moss", response_format: "diarized_json", [field]: "Alice" }));
    expect(res.status).toBe(400);
    expect(lastForm).toBeNull();
  });
});

describe("a diarizing model's real output", () => {
  const diarizingModel = () => modelFound({ ...transcriptionModel(), tags: ["diarization"] });
  // MOSS-Transcribe-Diarize on vLLM 0.31.1, a two-voice dialogue, streamed with response_format json.
  const deltas: string[] = ["[","0",".","0","6","]","[S","0","1","]"," Good"," morning"," everyone",".[","1",".","3","6","][","1",".","7","2","]","[S","0","1","]"," The"," new"," transcription"," pipeline"," is"," ready"," for"," evaluation",".[","5",".","0","6","][","5",".","4","2","]","[S","0","2","]"," Thanks",".[","6",".","1","2","][","6",".","4","6","]","[S","0","2","]"," How"," long"," does"," it"," take"," to"," process"," a"," full"," meeting"," recording","?[","1","0",".","2","6","][","1","0",".","6","2","]","[S","0","1","]"," About"," two"," minutes"," for"," an"," hour"," of"," audio"," on"," one"," machine",".[","1","4",".","2","2","]",""];
  const markup = deltas.join("");
  const plainText = "Good morning everyone. The new transcription pipeline is ready for evaluation. Thanks. How long does it take to process a full meeting recording? About two minutes for an hour of audio on one machine.";
  const stream = () => new Response(
    deltas.map((content, index) => `data: ${JSON.stringify({
      id: "t", object: "transcription.chunk", created: 1, model: "moss",
      choices: [{ delta: { content }, finish_reason: index === deltas.length - 1 ? "stop" : null }],
    })}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const events = async (res: Response) => (await res.text()).split("\n\n").filter(Boolean).map((line) => JSON.parse(line.slice("data: ".length)));

  test("streams the same segments vLLM's own diarized_json reports for it", async () => {
    getModelInfo.mockImplementationOnce(async () => diarizingModel());
    nextResponse = stream();
    const sent = await events(await handleTranscription(makeReq({ model: "moss", response_format: "diarized_json", stream: "true" })));
    expect(sent.filter(({ type }) => type === "transcript.text.segment").map(({ start, end, speaker }) => [start, end, speaker])).toEqual([
      [0.06, 1.36, "A"], [1.72, 5.06, "A"], [5.42, 6.12, "B"], [6.46, 10.26, "B"], [10.62, 14.22, "A"],
    ]);
    expect(sent.at(-1)).toMatchObject({ type: "transcript.text.done", text: plainText });
  });

  test("leaves the speaker markup out of a plain stream", async () => {
    getModelInfo.mockImplementationOnce(async () => diarizingModel());
    nextResponse = stream();
    const sent = await events(await handleTranscription(makeReq({ model: "moss", stream: "true" })));
    expect(sent.some(({ type }) => type === "transcript.text.segment")).toBe(false);
    expect(sent.some(({ segment_id }) => segment_id !== undefined)).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: "transcript.text.done", text: plainText });
  });

  test("leaves the speaker markup out of a plain json transcript", async () => {
    getModelInfo.mockImplementationOnce(async () => diarizingModel());
    nextResponse = Response.json({ text: markup, usage: { type: "duration", seconds: 15 } });
    const body = await (await handleTranscription(makeReq({ model: "moss" }))).json() as { text: string };
    expect(body.text).toBe(plainText);
  });
});
