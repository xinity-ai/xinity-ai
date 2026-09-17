import { verifyRequest } from "common-env";
import { resolveModel } from "../model-registry";
import { getAuthToken } from "../statekeeper";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "proxy" });

const PROXY_ROUTE_RE = /^\/proxy\/([^/]+)\/v1\/(.*)/;

function refuseUnsigned(req: Request, url: URL): Response | null {
  const result = verifyRequest(getAuthToken(), req.headers.get("authorization"), {
    method: req.method,
    path: `${url.pathname}${url.search}`,
  });
  if (result.ok) {
    return null;
  }
  // Only place this surfaces: a gateway whose clock drifted sees 401s with nothing else to go on.
  log.warn({ reason: result.reason, path: url.pathname }, "Proxy request rejected");
  return new Response(null, { status: 401 });
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const refused = refuseUnsigned(req, url);
  if (refused) {
    return refused;
  }

  const match = url.pathname.match(PROXY_ROUTE_RE);
  if (!match || match[1] === undefined) {
    return new Response(null, { status: 400 });
  }

  const model = decodeURIComponent(match[1]);
  const installation = resolveModel(model);
  if (!installation) {
    return new Response(null, { status: 404 });
  }

  const backendPath = `/v1/${match[2]}${url.search}`;
  const backendUrl = `http://127.0.0.1:${installation.port}${backendPath}`;

  try {
    return await fetch(backendUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
    });
  } catch (err) {
    log.error({ err, model, port: installation.port, path: backendPath }, "Proxy backend error");
    return new Response(null, { status: 502 });
  }
}
