import { withRunnerAuth } from "../auth/middleware";
import { openStateStream } from "../state/sse";

export const handleStream = withRunnerAuth((req) => {
  const nodeId = req.headers.get("x-node-id");
  if (!nodeId) {
    return new Response("Missing X-Node-Id header", { status: 400 });
  }
  return openStateStream(nodeId, req.signal);
});
