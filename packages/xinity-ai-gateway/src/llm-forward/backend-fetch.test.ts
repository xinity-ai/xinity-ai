import { describe, test, expect, afterEach } from "bun:test";
import { verifyRequest } from "common-env";
import { backendFetch, backendUrl } from "./backend-fetch";

const TOKEN = "node-auth-token-value";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture(): { sent: Request[] } {
  const sent: Request[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Request(String(input), init));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  return { sent };
}

describe("backendFetch", () => {
  const url = backendUrl("10.0.0.1:4044", "meta-llama/Llama-3.1-8B", "/v1/chat/completions", false);

  test("proves the node token without putting it on the wire", async () => {
    const { sent } = capture();

    await backendFetch(url, { method: "POST", authToken: TOKEN });

    const header = sent[0]!.headers.get("authorization")!;
    expect(header).not.toContain(TOKEN);
    expect(verifyRequest(TOKEN, header, {
      method: "POST",
      path: "/proxy/meta-llama%2FLlama-3.1-8B/v1/chat/completions",
    })).toEqual({ ok: true });
  });

  test("covers the query string, which selects streaming", async () => {
    const { sent } = capture();

    await backendFetch(`${url}?stream=true`, { method: "POST", authToken: TOKEN });

    const header = sent[0]!.headers.get("authorization")!;
    expect(verifyRequest(TOKEN, header, {
      method: "POST",
      path: "/proxy/meta-llama%2FLlama-3.1-8B/v1/chat/completions",
    }).ok).toBe(false);
  });

  test("sends no authorization at all when the node has no token yet", async () => {
    const { sent } = capture();

    await backendFetch(url, { method: "POST" });

    expect(sent[0]!.headers.get("authorization")).toBeNull();
  });
});

// The gateway signs the path it builds and the daemon verifies the one it receives, so the
// encoded specifier has to cross a real connection unchanged.
describe("across a real connection", () => {
  const daemonVerdictFor = async (specifier: string) => {
    let verdict: unknown;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        verdict = verifyRequest(TOKEN, req.headers.get("authorization"), {
          method: req.method,
          path: `${url.pathname}${url.search}`,
        });
        return new Response("{}");
      },
    });

    try {
      await backendFetch(
        backendUrl(`127.0.0.1:${server.port}`, specifier, "/v1/chat/completions", false),
        { method: "POST", authToken: TOKEN, body: "{}" },
      );
    } finally {
      server.stop(true);
    }
    return verdict;
  };

  test("the signature still matches when the model name contains a slash", async () => {
    expect(await daemonVerdictFor("meta-llama/Llama-3.1-8B")).toEqual({ ok: true });
  });

  test("the signature still matches when the model name contains a colon", async () => {
    expect(await daemonVerdictFor("llama3:latest")).toEqual({ ok: true });
  });
});
