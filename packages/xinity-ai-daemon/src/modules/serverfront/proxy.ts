import { resolveModel } from "../model-registry";
import { getAuthToken } from "../statekeeper";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "proxy" });

const PROXY_ROUTE_RE = /^\/proxy\/([^/]+)\/v1\/(.*)/;

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const expected = `Bearer ${getAuthToken()}`;
  if (req.headers.get("authorization") !== expected) {
    return new Response(null, { status: 401 });
  }

  const match = url.pathname.match(PROXY_ROUTE_RE);
  if (!match) {
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
    });
  } catch (err) {
    log.error({ err, model, port: installation.port, path: backendPath }, "Proxy backend error");
    return new Response(null, { status: 502 });
  }
}
