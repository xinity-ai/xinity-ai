import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { resolveAuth } from "../ai-sdk";
import type { AuthResult } from "../auth";
import { backendSocket } from "../backend-fetch";
import { getModelInfo, type ModelLookupFailure } from "../model-data";
import { recordFailedRequest, recordUsage } from "../usage";
import { errorResponse } from "../util";
import { createTranscriptionSession, type ModelResolution, type TranscriptionSession } from "../realtime/session";
import { TRANSCRIPTION_MODEL_TYPE } from "./handle-transcription";
import { recordTimeToFirstToken } from "../../metrics";
import { config } from "../../config";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "handle-realtime" });

const REALTIME_TAG = "realtime";

export type RealtimeSocketData = { auth: AuthResult; session?: TranscriptionSession };

const LOOKUP_REFUSALS: Record<ModelLookupFailure, { code: string; message: string }> = {
  unknown: { code: "model_not_found", message: "Model not found" },
  unavailable: { code: "model_unavailable", message: "Model has no ready inference node" },
  busy: { code: "model_busy", message: "Model is at capacity, please retry" },
};

const openSockets = new Set<ServerWebSocket<RealtimeSocketData>>();

async function resolveRealtimeModel(auth: AuthResult, publicModel: string): Promise<ModelResolution> {
  const lookup = await getModelInfo(auth.orgId, publicModel);
  if (lookup.status !== "found") {
    return { status: "refused", ...LOOKUP_REFUSALS[lookup.status] };
  }
  const info = lookup.info;
  if (info.type !== TRANSCRIPTION_MODEL_TYPE || !info.tags?.includes(REALTIME_TAG)) {
    info.release();
    return { status: "refused", code: "model_not_realtime", message: `Model '${publicModel}' does not support realtime transcription` };
  }
  return { status: "found", info };
}

/** OpenAI-compatible `/v1/realtime`, limited to transcription sessions. */
export async function handleRealtimeUpgrade(req: Request, server: Server<RealtimeSocketData>): Promise<Response | undefined> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse("Expected a WebSocket upgrade", 426, { Upgrade: "websocket" });
  }
  const auth = await resolveAuth(req);
  if (auth instanceof Response) {
    return auth;
  }
  if (server.upgrade(req, { data: { auth } })) {
    return undefined;
  }
  return errorResponse("WebSocket upgrade failed", 400);
}

export const realtimeSocketHandler: WebSocketHandler<RealtimeSocketData> = {
  open(ws) {
    openSockets.add(ws);
    const { auth } = ws.data;
    ws.data.session = createTranscriptionSession({
      send: (event) => ws.send(JSON.stringify(event)),
      resolveModel: (publicModel) => resolveRealtimeModel(auth, publicModel),
      connectEngine: (info, handlers) => {
        const socket = backendSocket(info, "/v1/realtime", {
          onMessage: (data) => {
            try {
              handlers.onEvent(JSON.parse(data));
            } catch (err) {
              log.warn({ err, installationId: info.installationId }, "Malformed realtime backend event, skipping");
            }
          },
          onClose: handlers.onClose,
        });
        return { send: (event) => socket.send(JSON.stringify(event)), close: socket.close };
      },
      recordTurn: ({ info, startedAt, usage, failed }) => {
        if (failed) {
          recordFailedRequest({ auth, modelInfo: info, callStartTime: startedAt });
        } else {
          recordUsage({ auth, modelInfo: info, callStartTime: startedAt, usage, logCalls: false });
        }
      },
      recordFirstDelta: recordTimeToFirstToken,
      engineTimeoutMs: config.inference.backendTimeoutMs(),
    });
  },
  message(ws, message) {
    ws.data.session?.receive(typeof message === "string" ? message : message.toString());
  },
  close(ws) {
    openSockets.delete(ws);
    ws.data.session?.close();
  },
};

export function closeRealtimeSessions(): void {
  for (const ws of openSockets) {
    ws.close(1001, "Gateway shutting down");
  }
}
