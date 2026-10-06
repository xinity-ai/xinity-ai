import { describe, test, expect, afterEach } from "bun:test";
import { withoutConnectionTimeout } from "./serve";

// Bun checks idle sockets on a roughly four second tick, so the shortest timeout closes a silent connection after about 4s.
const IDLE_TIMEOUT_S = 1;
const SILENCE_MS = 6_000;

function chunkThenSilence(): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("first "));
      await Bun.sleep(SILENCE_MS);
      controller.enqueue(encoder.encode("last"));
      controller.close();
    },
  }));
}

describe("withoutConnectionTimeout", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  test("keeps a response stream alive through silence longer than the server's idle timeout", async () => {
    server = Bun.serve({ port: 0, idleTimeout: IDLE_TIMEOUT_S, fetch: withoutConnectionTimeout(chunkThenSilence) });

    const res = await fetch(`http://localhost:${server.port}/`);
    expect(await res.text()).toBe("first last");
  }, SILENCE_MS + 5_000);
});
