import { z } from "zod";
import { createPcmInput, encodePcm16, type PcmInput } from "./audio";
import type { ModelInfo } from "../model-data";

export const ENGINE_SAMPLE_RATE = 16_000;
const INPUT_RATES = [24_000, 16_000];
const DEFAULT_INPUT_RATE = 24_000;
// Context left unused below maxContextLength: the engine's prompt prefix and the steps it runs past the final frame.
const CONTEXT_MARGIN_POSITIONS = 256;

export type EngineUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type ModelResolution =
  | { status: "found"; info: ModelInfo }
  | { status: "refused"; code: string; message: string };

export type EngineConnection = { send: (event: Record<string, unknown>) => void; close: () => void };

export type EngineHandlers = {
  onEvent: (event: unknown) => void;
  onClose: () => void;
};

export type TurnRecord = { info: ModelInfo; startedAt: number; usage?: EngineUsage; failed: boolean };

export type SessionDeps = {
  send: (event: Record<string, unknown>) => void;
  resolveModel: (publicModel: string) => Promise<ModelResolution>;
  connectEngine: (info: ModelInfo, handlers: EngineHandlers) => EngineConnection;
  recordTurn: (record: TurnRecord) => void;
  recordFirstDelta: (publicModel: string, startedAt: number) => void;
  engineTimeoutMs: number;
};

export type TranscriptionSession = {
  receive: (raw: string) => void;
  close: () => void;
};

const SessionUpdateSchema = z.object({
  type: z.literal("session.update"),
  event_id: z.string().optional(),
  session: z.looseObject({
    type: z.string(),
    audio: z.looseObject({
      input: z.looseObject({
        format: z.looseObject({ type: z.string(), rate: z.number().optional() }).optional(),
        transcription: z.looseObject({ model: z.string().optional() }).nullable().optional(),
        turn_detection: z.unknown().optional(),
      }).optional(),
    }).optional(),
  }),
});

const AppendSchema = z.object({
  type: z.literal("input_audio_buffer.append"),
  event_id: z.string().optional(),
  audio: z.string(),
});

const EngineEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.created") }),
  z.object({ type: z.literal("transcription.delta"), delta: z.string() }),
  z.object({
    type: z.literal("transcription.done"),
    text: z.string(),
    usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() }).nullable().optional(),
  }),
  z.object({ type: z.literal("error"), error: z.string(), code: z.string().nullable().optional() }),
]);

type EngineEvent = z.infer<typeof EngineEventSchema>;
type EngineEventOf<T extends EngineEvent["type"]> = Extract<EngineEvent, { type: T }>;

type SessionConfig = {
  publicModel: string;
  inputRate: number;
  maxTurnSamples: number;
};

type Turn = {
  itemId: string;
  startedAt: number;
  samples: number;
  queued: string[];
  text: string;
  info?: ModelInfo;
  engine?: EngineConnection;
  committed: boolean;
  /** Its output goes nowhere: the buffer was cleared or the client left. It still runs to completion so its usage is known. */
  discarded: boolean;
  /** No engine works on it anymore. A failed turn stays current until the client commits, swallowing the rest of its audio. */
  ended: boolean;
  firstDelta: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
};

type ErrorType = "invalid_request_error" | "server_error";

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function maxTurnSamples(info: ModelInfo): number | undefined {
  if (!info.audioPositionsPerSecond) {
    return undefined;
  }
  const samples = Math.floor(((info.maxContextLength - CONTEXT_MARGIN_POSITIONS) / info.audioPositionsPerSecond) * ENGINE_SAMPLE_RATE);
  return samples > 0 ? samples : undefined;
}

export function createTranscriptionSession(deps: SessionDeps): TranscriptionSession {
  const sessionId = randomId("sess");
  const turns = new Set<Turn>();
  let config: SessionConfig | undefined;
  let pcm: PcmInput = createPcmInput(DEFAULT_INPUT_RATE, ENGINE_SAMPLE_RATE);
  let current: Turn | undefined;
  let previousItemId: string | null = null;
  let closed = false;
  // Events are handled one at a time. An append never overtakes the session.update before it.
  let chain = Promise.resolve();

  const emit = (event: Record<string, unknown>) => {
    if (!closed) {
      deps.send({ event_id: randomId("event"), ...event });
    }
  };

  const emitError = (type: ErrorType, code: string, message: string, clientEventId?: string) => {
    emit({
      type: "error",
      error: { type, code, message, param: null, event_id: clientEventId ?? null },
    });
  };

  const sessionObject = () => ({
    type: "transcription",
    id: sessionId,
    object: "realtime.transcription_session",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: config?.inputRate ?? DEFAULT_INPUT_RATE },
        transcription: config ? { model: config.publicModel } : null,
        turn_detection: null,
        noise_reduction: null,
      },
    },
    include: null,
  });

  const disarm = (turn: Turn) => {
    clearTimeout(turn.watchdog);
    turn.watchdog = undefined;
  };

  const arm = (turn: Turn) => {
    if (!turn.watchdog && turn.engine && !turn.ended) {
      turn.watchdog = setTimeout(() => failTurn(turn, "The transcription backend stopped responding"), deps.engineTimeoutMs);
    }
  };

  const endTurn = (turn: Turn) => {
    turn.ended = true;
    disarm(turn);
    turns.delete(turn);
    turn.engine?.close();
    turn.info?.release();
  };

  const failTurn = (turn: Turn, message: string, code = "server_error", type: ErrorType = "server_error") => {
    if (turn.ended) {
      return;
    }
    if (turn.info) {
      deps.recordTurn({ info: turn.info, startedAt: turn.startedAt, failed: true });
    }
    endTurn(turn);
    if (!turn.discarded) {
      emitError(type, code, message);
    }
  };

  const markCommitted = (turn: Turn) => {
    turn.committed = true;
    if (current === turn) {
      current = undefined;
    }
  };

  const emitCommitted = (turn: Turn) => {
    emit({ type: "input_audio_buffer.committed", previous_item_id: previousItemId, item_id: turn.itemId });
    emit({
      type: "conversation.item.added",
      previous_item_id: previousItemId,
      item: {
        id: turn.itemId,
        object: "realtime.item",
        type: "message",
        status: "completed",
        role: "user",
        content: [{ type: "input_audio", transcript: null }],
      },
    });
    previousItemId = turn.itemId;
  };

  const sendFinal = (turn: Turn) => {
    if (turn.engine && !turn.ended) {
      turn.engine.send({ type: "input_audio_buffer.commit", final: true });
      arm(turn);
    }
  };

  const commitTurn = (turn: Turn) => {
    markCommitted(turn);
    if (turn.ended) {
      return;
    }
    if (!turn.discarded) {
      emitCommitted(turn);
    }
    sendFinal(turn);
  };

  const finishTurn = (turn: Turn, text: string, usage: EngineUsage | undefined) => {
    const committedByEngine = !turn.committed;
    markCommitted(turn);
    deps.recordTurn({ info: turn.info!, startedAt: turn.startedAt, usage, failed: false });
    endTurn(turn);
    if (turn.discarded) {
      return;
    }
    if (committedByEngine) {
      emitCommitted(turn);
    }
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: turn.itemId,
      content_index: 0,
      transcript: text,
      usage: usage && {
        type: "tokens",
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
    });
    emit({
      type: "conversation.item.done",
      previous_item_id: null,
      item: {
        id: turn.itemId,
        object: "realtime.item",
        type: "message",
        status: "completed",
        role: "user",
        content: [{ type: "input_audio", transcript: text }],
      },
    });
  };

  const engineEventHandlers: { [T in EngineEvent["type"]]: (turn: Turn, event: EngineEventOf<T>) => void } = {
    "session.created": () => {},
    "transcription.delta": (turn, event) => {
      if (event.delta.length === 0) {
        return;
      }
      turn.text += event.delta;
      if (!turn.firstDelta) {
        turn.firstDelta = true;
        deps.recordFirstDelta(config?.publicModel ?? turn.info!.model, turn.startedAt);
      }
      if (!turn.discarded) {
        emit({ type: "conversation.item.input_audio_transcription.delta", item_id: turn.itemId, content_index: 0, delta: event.delta });
      }
    },
    "transcription.done": (turn, event) => finishTurn(turn, event.text, event.usage ?? undefined),
    "error": (turn, event) => failTurn(turn, event.error),
  };

  const onEngineEvent = (turn: Turn, raw: unknown) => {
    if (turn.ended) {
      return;
    }
    disarm(turn);
    const parsed = EngineEventSchema.safeParse(raw);
    if (parsed.success) {
      (engineEventHandlers[parsed.data.type] as (turn: Turn, event: EngineEvent) => void)(turn, parsed.data);
    }
    if (turn.committed) {
      arm(turn);
    }
  };

  const connectTurn = async (turn: Turn, publicModel: string) => {
    const resolution = await deps.resolveModel(publicModel);
    if (resolution.status === "refused") {
      failTurn(turn, resolution.message, resolution.code, "invalid_request_error");
      return;
    }
    turn.info = resolution.info;
    if (turn.ended || (turn.discarded && turn.queued.length === 0)) {
      endTurn(turn);
      return;
    }
    turn.engine = deps.connectEngine(resolution.info, {
      onEvent: (event) => onEngineEvent(turn, event),
      onClose: () => failTurn(turn, "The transcription backend closed the connection before the transcript was complete"),
    });
    turn.engine.send({ type: "session.update", model: resolution.info.model });
    turn.engine.send({ type: "input_audio_buffer.commit" });
    for (const audio of turn.queued.splice(0)) {
      turn.engine.send({ type: "input_audio_buffer.append", audio });
    }
    if (turn.committed) {
      sendFinal(turn);
    } else {
      arm(turn);
    }
  };

  const startTurn = (publicModel: string): Turn => {
    const turn: Turn = {
      itemId: randomId("item"),
      startedAt: Date.now(),
      samples: 0,
      queued: [],
      text: "",
      committed: false,
      discarded: false,
      ended: false,
      firstDelta: false,
    };
    turns.add(turn);
    current = turn;
    void connectTurn(turn, publicModel);
    return turn;
  };

  const forwardAudio = (turn: Turn, samples: Int16Array) => {
    turn.samples += samples.length;
    if (turn.ended) {
      return;
    }
    const audio = encodePcm16(samples);
    if (turn.engine) {
      turn.engine.send({ type: "input_audio_buffer.append", audio });
      arm(turn);
    } else {
      turn.queued.push(audio);
    }
  };

  const discard = (turn: Turn) => {
    turn.discarded = true;
    if (!turn.committed) {
      markCommitted(turn);
      sendFinal(turn);
    }
  };

  const handleSessionUpdate = async (raw: unknown) => {
    const parsed = SessionUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      emitError("invalid_request_error", "invalid_value", "Malformed session.update event");
      return;
    }
    const { session, event_id: eventId } = parsed.data;
    const refuse = (code: string, message: string) => emitError("invalid_request_error", code, message, eventId);
    if (session.type !== "transcription") {
      refuse("unsupported_session_type", "Only transcription sessions are supported");
      return;
    }
    const input = session.audio?.input;
    if (input?.turn_detection !== undefined && input.turn_detection !== null) {
      refuse("unsupported_turn_detection", "Turn detection is not supported. Set turn_detection to null and commit each turn");
      return;
    }
    const format = input?.format;
    if (format && format.type !== "audio/pcm") {
      refuse("unsupported_audio_format", "Only audio/pcm input is supported");
      return;
    }
    const inputRate = format?.rate ?? config?.inputRate ?? DEFAULT_INPUT_RATE;
    if (!INPUT_RATES.includes(inputRate)) {
      refuse("unsupported_audio_format", `Supported audio/pcm rates are ${INPUT_RATES.join(" and ")}`);
      return;
    }
    if (config && inputRate !== config.inputRate && current) {
      refuse("invalid_value", "The audio format cannot change while audio is uncommitted");
      return;
    }

    const publicModel = input?.transcription?.model ?? config?.publicModel;
    if (!publicModel) {
      refuse("missing_model", "Set audio.input.transcription.model");
      return;
    }

    let turnSamples = config?.maxTurnSamples;
    if (publicModel !== config?.publicModel) {
      const resolution = await deps.resolveModel(publicModel);
      if (resolution.status === "refused") {
        refuse(resolution.code, resolution.message);
        return;
      }
      resolution.info.release();
      turnSamples = maxTurnSamples(resolution.info);
    }
    if (turnSamples === undefined) {
      refuse("model_not_realtime", `Model '${publicModel}' does not support realtime transcription`);
      return;
    }

    if (inputRate !== config?.inputRate) {
      pcm = createPcmInput(inputRate, ENGINE_SAMPLE_RATE);
    }
    config = { publicModel, inputRate, maxTurnSamples: turnSamples };
    emit({ type: "session.updated", session: sessionObject() });
  };

  const handleAppend = (raw: unknown) => {
    const parsed = AppendSchema.safeParse(raw);
    if (!parsed.success) {
      emitError("invalid_request_error", "invalid_value", "input_audio_buffer.append needs base64 audio");
      return;
    }
    if (!config) {
      emitError("invalid_request_error", "session_not_configured", "Send session.update with a transcription model before audio", parsed.data.event_id);
      return;
    }
    const samples = pcm.push(parsed.data.audio);
    let offset = 0;
    while (offset < samples.length) {
      const turn = current ?? startTurn(config.publicModel);
      const part = samples.subarray(offset, offset + config.maxTurnSamples - turn.samples);
      forwardAudio(turn, part);
      offset += part.length;
      if (turn.samples >= config.maxTurnSamples) {
        commitTurn(turn);
      }
    }
  };

  const handleCommit = (eventId: string | undefined) => {
    if (!current || current.samples === 0) {
      emitError("invalid_request_error", "input_audio_buffer_commit_empty", "The input audio buffer is empty", eventId);
      return;
    }
    commitTurn(current);
  };

  const handleClear = () => {
    if (current) {
      discard(current);
    }
    pcm = createPcmInput(config?.inputRate ?? DEFAULT_INPUT_RATE, ENGINE_SAMPLE_RATE);
    emit({ type: "input_audio_buffer.cleared" });
  };

  const clientEventHandlers: Record<string, (event: unknown, eventId: string | undefined) => void | Promise<void>> = {
    "session.update": (event) => handleSessionUpdate(event),
    "input_audio_buffer.append": (event) => handleAppend(event),
    "input_audio_buffer.commit": (_event, eventId) => handleCommit(eventId),
    "input_audio_buffer.clear": () => handleClear(),
  };

  const handle = async (raw: string) => {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      emitError("invalid_request_error", "invalid_json", "Events must be JSON");
      return;
    }
    const { type, event_id: eventId } = (event ?? {}) as { type?: unknown; event_id?: string };
    const handler = typeof type === "string" ? clientEventHandlers[type] : undefined;
    if (!handler) {
      emitError("invalid_request_error", "unsupported_event", `Event type '${String(type)}' is not supported in a transcription session`, eventId);
      return;
    }
    await handler(event, eventId);
  };

  emit({ type: "session.created", session: sessionObject() });

  return {
    receive: (raw) => {
      chain = chain.then(() => handle(raw)).catch(() => emitError("server_error", "server_error", "The event could not be processed"));
    },
    close: () => {
      for (const turn of turns) {
        discard(turn);
      }
      closed = true;
    },
  };
}
