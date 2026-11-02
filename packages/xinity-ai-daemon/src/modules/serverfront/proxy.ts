import type { Server, WebSocketHandler } from "bun";
import { createRequestVerifier, type VerifyFailure } from "common-env";
import { resolveInstallation } from "../model-registry";
import { getAuthToken } from "../statekeeper";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "proxy" });

const PROXY_ROUTE_RE = /^\/proxy\/([^/]+)\/v1\/(.*)/;

const verifyOnce = createRequestVerifier();

/** Read by the gateway operator, who otherwise cannot tell a drifted clock from a wrong or absent token. */
function refusalDetail(reason: VerifyFailure): string {
  switch (reason) {
    case "missing":
      return "No Authorization header. The gateway holds no auth token for this node.";
    case "malformed":
      return "Authorization header is not a Xinity signature. The gateway may predate request signing.";
    case "stale":
      return `Signature timestamp is outside the accepted window. This daemon's clock reads ${new Date().toISOString()}. Compare it with the gateway's clock.`;
    case "mismatch":
      return "Signature does not match this node's auth token. The gateway holds a different token for this node.";
    case "replayed":
      return "This signature was already used. Either the request was replayed, or the gateway sent it again without signing anew.";
  }
}

function refuseUnsigned(req: Request, url: URL): Response | null {
  const result = verifyOnce(getAuthToken(), req.headers.get("authorization"), {
    method: req.method,
    path: `${url.pathname}${url.search}`,
  });
  if (result.ok) {
    return null;
  }
  log.warn({ reason: result.reason, path: url.pathname }, "Proxy request rejected");
  return new Response(`Unauthorized: ${refusalDetail(result.reason)}`, { status: 401 });
}

type ProxyTarget = {
  installationId: string;
  installation: NonNullable<ReturnType<typeof resolveInstallation>>;
  backendPath: string;
};

function resolveProxyTarget(req: Request, url: URL): ProxyTarget | Response {
  const refused = refuseUnsigned(req, url);
  if (refused) {
    return refused;
  }

  const match = url.pathname.match(PROXY_ROUTE_RE);
  if (!match || match[1] === undefined) {
    return new Response(null, { status: 400 });
  }

  const installationId = decodeURIComponent(match[1]);
  const installation = resolveInstallation(installationId);
  if (!installation) {
    return new Response(null, { status: 404 });
  }

  return { installationId, installation, backendPath: `/v1/${match[2]}${url.search}` };
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const target = resolveProxyTarget(req, url);
  if (target instanceof Response) {
    return target;
  }
  const { installationId, installation, backendPath } = target;
  const backendUrl = `http://127.0.0.1:${installation.port}${backendPath}`;

  try {
    return await fetch(backendUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
    });
  } catch (err) {
    log.error({ err, installationId, specifier: installation.specifier, port: installation.port, path: backendPath }, "Proxy backend error");
    return new Response(null, { status: 502 });
  }
}

type QueuedMessage = string | Buffer<ArrayBuffer>;
type SocketRelay = { forward: (message: QueuedMessage) => void; close: () => void };

export type ProxySocketData = {
  installationId: string;
  backendUrl: string;
  relay?: SocketRelay;
};

/** Returns a refusal, or undefined once the connection has been handed to the relay handler. */
export function handleProxyUpgrade(req: Request, url: URL, server: Server<ProxySocketData>): Response | undefined {
  const target = resolveProxyTarget(req, url);
  if (target instanceof Response) {
    return target;
  }
  const data: ProxySocketData = {
    installationId: target.installationId,
    backendUrl: `ws://127.0.0.1:${target.installation.port}${target.backendPath}`,
  };
  if (server.upgrade(req, { data })) {
    return undefined;
  }
  return new Response("Expected a WebSocket upgrade", { status: 400 });
}

// These codes only describe a closure locally and may not be sent to a peer.
const LOCAL_CLOSE_CODE_SUBSTITUTES: Record<number, number> = {
  1005: 1000,
  1006: 1011,
};

type ConnectingRelay = { since: number; pending: QueuedMessage[] };

const connectingRelays = new Set<ConnectingRelay>();

export type ConnectingRelayStats = { connections: number; queuedBytes: number; oldestSeconds: number };

export function connectingRelayStats(now = Date.now()): ConnectingRelayStats {
  let queuedBytes = 0;
  let oldest = now;
  for (const relay of connectingRelays) {
    oldest = Math.min(oldest, relay.since);
    for (const message of relay.pending) {
      queuedBytes += typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
    }
  }
  return { connections: connectingRelays.size, queuedBytes, oldestSeconds: (now - oldest) / 1000 };
}

// An engine answers a local handshake in milliseconds, so this only ends one that has stalled.
const BACKEND_CONNECT_TIMEOUT_MS = 10_000;

export function createProxySocketHandler(connectTimeoutMs = BACKEND_CONNECT_TIMEOUT_MS): WebSocketHandler<ProxySocketData> {
  return {
    open(ws) {
      const backend = new WebSocket(ws.data.backendUrl);
      backend.binaryType = "arraybuffer";
      const pending: QueuedMessage[] = [];
      const connecting: ConnectingRelay = { since: Date.now(), pending };
      connectingRelays.add(connecting);

      const connectTimer = setTimeout(() => {
        log.warn({ installationId: ws.data.installationId, url: ws.data.backendUrl, connectTimeoutMs }, "Proxy backend WebSocket handshake timed out");
        backend.close();
      }, connectTimeoutMs);

      backend.addEventListener("open", () => {
        clearTimeout(connectTimer);
        connectingRelays.delete(connecting);
        for (const message of pending.splice(0)) {
          backend.send(message);
        }
      });
      backend.addEventListener("message", (event) => {
        ws.send(event.data);
      });
      backend.addEventListener("error", () => {
        log.warn({ installationId: ws.data.installationId, url: ws.data.backendUrl }, "Proxy backend WebSocket error");
      });
      backend.addEventListener("close", (event) => {
        clearTimeout(connectTimer);
        connectingRelays.delete(connecting);
        ws.close(LOCAL_CLOSE_CODE_SUBSTITUTES[event.code] ?? event.code, event.reason);
      });

      ws.data.relay = {
        forward: (message) => {
          if (backend.readyState === WebSocket.OPEN) {
            backend.send(message);
          } else {
            pending.push(message);
          }
        },
        close: () => backend.close(),
      };
    },
    message(ws, message) {
      ws.data.relay?.forward(message);
    },
    close(ws) {
      ws.data.relay?.close();
    },
  };
}
