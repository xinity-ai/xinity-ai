import { StatusReport } from "common-env";
import { withRunnerAuth } from "../auth/middleware";
import { enqueue } from "../status/buffer";

export const handleStatus = withRunnerAuth(async (req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const parsed = StatusReport.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid status report", issues: parsed.error.issues }, { status: 400 });
  }

  const buffered = enqueue(parsed.data.nodeId, parsed.data.registration, parsed.data.installations);
  if (!buffered) {
    return new Response("Status buffer full", { status: 429 });
  }
  return new Response(null, { status: 202 });
});
