import { describe, expect, test } from "bun:test";
import { encodePcm16 } from "./audio";
import { createTranscriptionSession, type EngineHandlers, type ModelResolution, type TurnRecord } from "./session";
import type { ModelInfo } from "../model-data";

type Event = Record<string, any>;

type FakeEngine = {
  received: Event[];
  emit: (event: Event) => void;
  drop: () => void;
  closed: boolean;
};

function harness(options: { maxContextLength?: number; refuse?: () => ModelResolution | undefined; engineTimeoutMs?: number } = {}) {
  const sent: Event[] = [];
  const engines: FakeEngine[] = [];
  const turns: TurnRecord[] = [];
  let leases = 0;
  let released = 0;

  const info = (): ModelInfo => {
    leases += 1;
    return {
      nodeId: "node-1",
      host: "node:4000",
      installationId: "inst-1",
      specifier: "voxtral-realtime",
      model: "mistralai/Voxtral-Mini-4B-Realtime-2602",
      driver: "vllm",
      authToken: null,
      tls: false,
      type: "transcription",
      tags: ["realtime"],
      maxContextLength: options.maxContextLength ?? 8192,
      audioPositionsPerSecond: 12.5,
      release: () => {
        released += 1;
      },
    };
  };

  const session = createTranscriptionSession({
    send: (event) => sent.push(event),
    resolveModel: async () => options.refuse?.() ?? { status: "found", info: info() },
    connectEngine: (_info, handlers: EngineHandlers) => {
      const engine: FakeEngine = {
        received: [],
        emit: (event) => handlers.onEvent(event),
        drop: () => handlers.onClose(),
        closed: false,
      };
      engines.push(engine);
      return {
        send: (event) => engine.received.push(event),
        close: () => {
          engine.closed = true;
        },
      };
    },
    recordTurn: (record) => turns.push(record),
    recordFirstDelta: () => {},
    engineTimeoutMs: options.engineTimeoutMs ?? 60_000,
  });

  const send = async (event: Event) => {
    session.receive(JSON.stringify(event));
    await Bun.sleep(1);
  };

  return {
    session,
    sent,
    engines,
    turns,
    send,
    leases: () => leases,
    released: () => released,
    ofType: (type: string) => sent.filter((event) => event.type === type),
    configure: (rate = 16_000) => send({
      type: "session.update",
      session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate }, transcription: { model: "voxtral" }, turn_detection: null } } },
    }),
    append: (samples: number) => send({ type: "input_audio_buffer.append", audio: encodePcm16(new Int16Array(samples).fill(1000)) }),
  };
}

function samplesSent(engine: FakeEngine): number {
  return engine.received
    .filter((event) => event.type === "input_audio_buffer.append")
    .reduce((sum, event) => sum + Buffer.from(event.audio, "base64").length / 2, 0);
}

const DONE = { type: "transcription.done", text: "Hello there", usage: { prompt_tokens: 39, completion_tokens: 20, total_tokens: 59 } };

describe("session configuration", () => {
  test("announces itself as a transcription session", () => {
    const h = harness();
    expect(h.sent[0]).toMatchObject({ type: "session.created", session: { type: "transcription" } });
  });

  test("refuses a conversation session", async () => {
    const h = harness();
    await h.send({ type: "session.update", session: { type: "realtime" } });
    expect(h.ofType("error")[0]!.error.code).toBe("unsupported_session_type");
  });

  test("refuses server-side turn detection", async () => {
    const h = harness();
    await h.send({
      type: "session.update",
      session: { type: "transcription", audio: { input: { transcription: { model: "voxtral" }, turn_detection: { type: "server_vad" } } } },
    });
    expect(h.ofType("error")[0]!.error.code).toBe("unsupported_turn_detection");
  });

  test("refuses audio before a model is configured", async () => {
    const h = harness();
    await h.append(1600);
    expect(h.ofType("error")[0]!.error.code).toBe("session_not_configured");
  });

  test("passes the model's refusal on, without holding its lease", async () => {
    const h = harness({ refuse: () => ({ status: "refused", code: "model_not_realtime", message: "no" }) });
    await h.configure();
    expect(h.ofType("error")[0]!.error.code).toBe("model_not_realtime");
    expect(h.ofType("session.updated")).toHaveLength(0);
  });

  test("checks the model without keeping a lease for the session", async () => {
    const h = harness();
    await h.configure();
    expect(h.ofType("session.updated")).toHaveLength(1);
    expect(h.leases()).toBe(h.released());
  });
});

describe("a turn", () => {
  test("streams audio to the engine and the transcript back under one item", async () => {
    const h = harness();
    await h.configure();
    await h.append(1600);
    const [engine] = h.engines;
    expect(engine!.received.slice(0, 2)).toEqual([
      { type: "session.update", model: "mistralai/Voxtral-Mini-4B-Realtime-2602" },
      { type: "input_audio_buffer.commit" },
    ]);
    expect(samplesSent(engine!)).toBe(1600);

    engine!.emit({ type: "transcription.delta", delta: "" });
    engine!.emit({ type: "transcription.delta", delta: "Hello" });
    await h.send({ type: "input_audio_buffer.commit" });
    expect(engine!.received.at(-1)).toEqual({ type: "input_audio_buffer.commit", final: true });

    engine!.emit(DONE);
    const [delta] = h.ofType("conversation.item.input_audio_transcription.delta");
    const [committed] = h.ofType("input_audio_buffer.committed");
    const [completed] = h.ofType("conversation.item.input_audio_transcription.completed");
    expect(h.ofType("conversation.item.input_audio_transcription.delta")).toHaveLength(1);
    expect(delta!.item_id).toBe(committed!.item_id);
    expect(completed).toMatchObject({ item_id: committed!.item_id, transcript: "Hello there", usage: { input_tokens: 39, output_tokens: 20 } });
    expect(h.turns).toEqual([expect.objectContaining({ failed: false, usage: DONE.usage })]);
    expect(engine!.closed).toBe(true);
    expect(h.leases()).toBe(h.released());
  });

  test("starts the next turn on a fresh engine connection", async () => {
    const h = harness();
    await h.configure();
    await h.append(1600);
    await h.send({ type: "input_audio_buffer.commit" });
    await h.append(1600);
    expect(h.engines).toHaveLength(2);
    expect(samplesSent(h.engines[1]!)).toBe(1600);
  });

  test("resamples 24 kHz input to the engine's 16 kHz", async () => {
    const h = harness();
    await h.configure(24_000);
    await h.append(24_000);
    expect(Math.abs(samplesSent(h.engines[0]!) - 16_000)).toBeLessThan(16);
  });

  test("refuses to commit an empty buffer", async () => {
    const h = harness();
    await h.configure();
    await h.send({ type: "input_audio_buffer.commit" });
    expect(h.ofType("error")[0]!.error.code).toBe("input_audio_buffer_commit_empty");
  });

  test("reports a transcript the engine ended on its own as committed first", async () => {
    const h = harness();
    await h.configure();
    await h.append(1600);
    h.engines[0]!.emit(DONE);
    expect(h.sent.map((event) => event.type).slice(-4)).toEqual([
      "input_audio_buffer.committed",
      "conversation.item.added",
      "conversation.item.input_audio_transcription.completed",
      "conversation.item.done",
    ]);
  });
});

describe("the per-turn audio cap", () => {
  // (256 + 12.5) positions leave one second of audio per turn.
  const oneSecondContext = 256 + 12.5;

  test("commits a turn at the cap and carries on in a new one", async () => {
    const h = harness({ maxContextLength: oneSecondContext });
    await h.configure();
    await h.append(24_000);
    expect(h.ofType("input_audio_buffer.committed")).toHaveLength(1);
    expect(h.engines).toHaveLength(2);
    expect(samplesSent(h.engines[0]!)).toBe(16_000);
    expect(h.engines[0]!.received.at(-1)).toEqual({ type: "input_audio_buffer.commit", final: true });
    expect(samplesSent(h.engines[1]!)).toBe(8_000);
  });
});

describe("abandoned audio", () => {
  test("a cleared turn still runs to completion for its usage, without reporting a transcript", async () => {
    const h = harness();
    await h.configure();
    await h.append(1600);
    await h.send({ type: "input_audio_buffer.clear" });
    expect(h.ofType("input_audio_buffer.cleared")).toHaveLength(1);
    expect(h.engines[0]!.received.at(-1)).toEqual({ type: "input_audio_buffer.commit", final: true });

    h.engines[0]!.emit(DONE);
    expect(h.ofType("conversation.item.input_audio_transcription.completed")).toHaveLength(0);
    expect(h.ofType("input_audio_buffer.committed")).toHaveLength(0);
    expect(h.turns).toEqual([expect.objectContaining({ failed: false, usage: DONE.usage })]);
    expect(h.leases()).toBe(h.released());
  });

  test("a client leaving mid-turn finishes the turn quietly and records it", async () => {
    const h = harness();
    await h.configure();
    await h.append(1600);
    const before = h.sent.length;
    h.session.close();
    h.engines[0]!.emit(DONE);
    expect(h.sent).toHaveLength(before);
    expect(h.turns).toHaveLength(1);
    expect(h.leases()).toBe(h.released());
  });
});

describe("engine failures", () => {
  test("an engine that drops the connection fails the turn and frees its lease", async () => {
    const h = harness();
    await h.configure();
    await h.append(1600);
    h.engines[0]!.drop();
    expect(h.ofType("error")[0]!.error.type).toBe("server_error");
    expect(h.turns).toEqual([expect.objectContaining({ failed: true })]);
    expect(h.leases()).toBe(h.released());
  });

  test("an engine that goes silent after the commit fails the turn", async () => {
    const h = harness({ engineTimeoutMs: 20 });
    await h.configure();
    await h.append(1600);
    h.engines[0]!.emit({ type: "transcription.delta", delta: "Hi" });
    await h.send({ type: "input_audio_buffer.commit" });
    await Bun.sleep(50);
    expect(h.ofType("error")[0]!.error.message).toContain("stopped responding");
    expect(h.engines[0]!.closed).toBe(true);
  });

  test("a turn the model refuses reports once and swallows the rest of its audio", async () => {
    let refuse = false;
    const h = harness({ refuse: () => (refuse ? { status: "refused", code: "model_busy", message: "busy" } : undefined) });
    await h.configure();
    refuse = true;
    await h.append(1600);
    await h.append(1600);
    await h.send({ type: "input_audio_buffer.commit" });
    expect(h.ofType("error").map((event) => event.error.code)).toEqual(["model_busy"]);

    refuse = false;
    await h.append(1600);
    expect(h.engines).toHaveLength(1);
  });
});
