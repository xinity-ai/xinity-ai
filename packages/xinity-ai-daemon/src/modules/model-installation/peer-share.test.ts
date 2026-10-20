import { describe, test, expect, mock, beforeAll, afterAll, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { signRequest } from "common-env";
import { mockDaemonConfig } from "../../mock-config";

const testCacheDir = path.join(os.tmpdir(), `peer-share-test-${Date.now()}`);

mock.module("../../config", () => ({ config: mockDaemonConfig({ VLLM_HF_CACHE_DIR: testCacheDir }) }));
mock.module("../../logger", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const { peerShareHandler, peerSourceFor } = await import("./peer-share");

const SECRET = "group-secret";
const model = "nvidia/Qwen3.8-Flash-Next-NVFP4";
const finished = "a".repeat(64);
const partial = "b".repeat(64);
const blobs = path.join(testCacheDir, "hub", `models--${model.replace("/", "--")}`, "blobs");
const contents = new TextEncoder().encode("0123456789");

const handle = peerShareHandler(() => new Set([model]), () => SECRET);

function get(blobPath: string, headers: Record<string, string> = {}, signedPath = blobPath): Promise<Response> {
  return handle(new Request(`http://192.168.100.1:29400${blobPath}`, {
    headers: { authorization: signRequest(SECRET, { method: "GET", path: signedPath }), ...headers },
  }));
}

beforeAll(() => {
  fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, finished), contents);
  fs.writeFileSync(path.join(blobs, `${partial}.incomplete`), contents.subarray(0, 4));
});

afterAll(() => {
  fs.rmSync(testCacheDir, { recursive: true, force: true });
});

describe("peerShareHandler", () => {
  test("serves a finished file whole and from where a copy left off", async () => {
    const whole = await get(`/blobs/${model}/${finished}`);
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(contents);

    const resumed = await get(`/blobs/${model}/${finished}`, { range: "bytes=4-" });
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(contents.subarray(4));

    expect((await get(`/blobs/${model}/${finished}`, { range: "bytes=10-" })).status).toBe(416);
  });

  test("says how far a file still downloading has got, and when it has no file at all", async () => {
    const downloading = await get(`/blobs/${model}/${partial}`);
    expect(downloading.status).toBe(404);
    expect(await downloading.json()).toEqual({ state: "downloading", bytes: 4 });

    const absent = await get(`/blobs/${model}/${"c".repeat(64)}`);
    expect(await absent.json()).toEqual({ state: "absent" });
  });

  test("refuses a model it does not share, an unsigned or replayed request, and one signed for another path", async () => {
    expect((await get(`/blobs/other/model/${finished}`)).status).toBe(403);

    const unsigned = await handle(new Request(`http://192.168.100.1:29400/blobs/${model}/${finished}`));
    expect(unsigned.status).toBe(401);

    const authorization = signRequest(SECRET, { method: "GET", path: `/blobs/${model}/${finished}` });
    const once = () => handle(new Request(`http://192.168.100.1:29400/blobs/${model}/${finished}`, { headers: { authorization } }));
    expect((await once()).status).toBe(200);
    expect((await once()).status).toBe(401);

    expect((await get(`/blobs/${model}/${finished}`, {}, `/blobs/${model}/${partial}`)).status).toBe(401);
  });

  test("answers nothing but blob requests", async () => {
    expect((await get("/../../etc/passwd")).status).toBe(404);
    expect((await handle(new Request(`http://192.168.100.1:29400/blobs/${model}/${finished}`, { method: "DELETE" }))).status).toBe(404);
  });
});

describe("peerSourceFor", () => {
  const leaderAddress = "192.168.100.1";
  const group = (rank: number, masterHostAddress: string | null) => ({
    id: "group-1", rank, size: 2, parallelism: "tensor" as const, rendezvousPort: 29500, generation: 1,
    addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.253" }],
    masterAddress: "192.168.100.254",
    masterHost: { machineName: "asus-7", address: masterHostAddress },
    members: [],
  });
  const copyDir = path.join(testCacheDir, "copies");
  const request = (etag: string, stallMs = 1000, sha256?: string) => ({
    model, etag, sha256, incompletePath: path.join(copyDir, `${etag}.incomplete`), expectedSize: contents.byteLength, stallMs, onBytes: async () => {},
  });
  const peerFile = (state: object) => Response.json(state, { status: 404 });

  async function fetchFromPeer(answer: (attempt: number) => Response, etag: string, stallMs?: number, sha256?: string) {
    fs.mkdirSync(copyDir, { recursive: true });
    const calls: { url: string; headers: RequestInit["headers"] }[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers });
      return answer(calls.length);
    }) as typeof fetch);
    try {
      const fetched = await peerSourceFor(group(1, leaderAddress))!.fetch(request(etag, stallMs, sha256));
      return { fetched, calls, path: request(etag).incompletePath };
    } finally {
      fetchSpy.mockRestore();
    }
  }

  test("names rank 0's machine as the source for the other members, and none for rank 0 or without its address", () => {
    expect(peerSourceFor(group(1, leaderAddress))?.name).toBe("asus-7");
    expect(peerSourceFor(group(0, leaderAddress))).toBeUndefined();
    expect(peerSourceFor(group(1, null))).toBeUndefined();
    expect(peerSourceFor(null)).toBeUndefined();
  });

  test("copies a file rank 0 has finished, with a signed request to its address on the coupling", async () => {
    const { fetched, calls, path: copied } = await fetchFromPeer(() => new Response(contents), "etag-finished");

    expect(fetched).toBe(true);
    expect(calls[0]).toEqual({ url: `http://192.168.100.1:29400/blobs/${model}/etag-finished`, headers: { authorization: expect.stringMatching(/^Xinity /) } });
    expect(new Uint8Array(fs.readFileSync(copied))).toEqual(contents);
  });

  test("waits while rank 0 is still downloading the file, then copies it", async () => {
    const { fetched, calls } = await fetchFromPeer(
      (attempt) => (attempt < 3 ? peerFile({ state: "downloading", bytes: attempt * 4 }) : new Response(contents)),
      "etag-growing",
      200,
    );

    expect(fetched).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test("declines once rank 0's download stops growing, or when it lacks the file or refuses", async () => {
    for (const answer of [() => peerFile({ state: "downloading", bytes: 4 }), () => peerFile({ state: "absent" }), () => new Response("Unauthorized", { status: 401 })]) {
      expect((await fetchFromPeer(answer, "etag-declined", 100)).fetched).toBe(false);
    }
  });

  test("checks a copy against the SHA-256 the listing gives, not the cache's name for the file, and discards one that does not match", async () => {
    const sha256 = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
    const xetName = "3c653ee4bb017a72ca3b540a8a86828246dc45d6409bb2f89aa115a2f951bab7";
    expect((await fetchFromPeer(() => new Response(contents), xetName, 1000, sha256)).fetched).toBe(true);

    const { fetched, path: copied } = await fetchFromPeer(() => new Response(new TextEncoder().encode("9876543210")), "etag-broken", 1000, sha256);
    expect(fetched).toBe(false);
    expect(fs.existsSync(copied)).toBe(false);
  });
});
