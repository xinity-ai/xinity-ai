import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, mediaObjectT } from "common-db";

mock.module("./env", () => ({
  env: {
    S3_ENDPOINT: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_BUCKET: "xinity-media",
    S3_REGION: "us-east-1",
  },
}));

const _noop = () => {};
const _mockChild = (): Record<string, unknown> => ({ trace: _noop, debug: _noop, info: _noop, warn: _noop, error: _noop, fatal: _noop, child: _mockChild });
mock.module("./logger", () => ({ rootLogger: { child: _mockChild } }));

const db = drizzle.mock();
type CapturedQuery = { sql: string; params: unknown[] };
const capturedQueries: CapturedQuery[] = [];
/** The media_object rows the next select finds. Empty means "no such object". */
let storedMediaRows: Array<{ s3Key: string | null; mimeType: string; bytes?: Uint8Array | null }> = [];
const preparedProto = Object.getPrototypeOf(db.select().from(mediaObjectT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  return /^\s*select/i.test(this.queryString) ? storedMediaRows : [];
});

mock.module("./db", () => ({
  getDB: () => db,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

const { processMessageImages, resolveMediaRef, restoreMessageImages } = await import("./image-store");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal 1×1 PNG, base64-encoded. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

function makeImageStore(writeFn = mock(() => Promise.resolve())) {
  return {
    client: { write: writeFn } as any,
    bucket: "xinity-media",
  };
}

/** Find the media_object INSERT in captured queries. */
function findInsert(): CapturedQuery | undefined {
  return capturedQueries.find((q) => q.sql.includes("media_object"));
}

// ─── processMessageImages – S3 enabled ───────────────────────────────────────

describe("processMessageImages – S3 enabled", () => {
  let writeCall: ReturnType<typeof mock>;
  let store: ReturnType<typeof makeImageStore>;

  beforeEach(() => {
    capturedQueries.length = 0;
    writeCall = mock(() => Promise.resolve());
    store = makeImageStore(writeCall);
  });

  test("data URI: LLM receives data URI, DB receives xinity-media:// reference", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this image:" },
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
        ],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store, true);

    const llmParts = messagesForLLM[0]!.content as any[];
    expect(llmParts[0]).toEqual({ type: "text", text: "Look at this image:" });
    expect(llmParts[1]!.image_url.url).toBe(TINY_PNG_DATA_URI);

    const dbParts = messagesForDB[0]!.content as any[];
    expect(dbParts[0]).toEqual({ type: "text", text: "Look at this image:" });
    expect(dbParts[1]!.image_url.url).toMatch(/^xinity-media:\/\/[0-9a-f]{64}$/);
  });

  test("data URI: INSERT targets media_object with correct values", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    await processMessageImages(messages, "org-1", store, true);

    const q = findInsert();
    expect(q).toBeDefined();
    expect(q!.sql).toContain("media_object");
    expect(q!.sql).toContain("on conflict do nothing");
    expect(q!.params).toContain("image/png");     // mimeType
    expect(q!.params).toContain("xinity-media");  // s3Bucket
    expect(q!.params).toContain("org-1");          // organizationId
    expect(q!.params).not.toContain(TINY_PNG_DATA_URI);
    // sha256 is a 64-char hex string
    const sha256Param = (q!.params as string[]).find((p) => /^[0-9a-f]{64}$/.test(p));
    expect(sha256Param).toBeDefined();
    // S3 key is orgId/sha256
    expect(q!.params).toContain(`org-1/${sha256Param}`);
  });

  test("data URI: S3 write uses orgId/sha256 key", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    await processMessageImages(messages, "org-abc", store, true);

    expect(writeCall).toHaveBeenCalledTimes(1);
    const [s3Key] = writeCall.mock.calls[0] as [string, ...unknown[]];
    expect(s3Key).toMatch(/^org-abc\/[0-9a-f]{64}$/);
  });

  test("same image twice: two inserts both with on conflict do nothing, same xinity-media:// URL in DB", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
        ],
      },
    ] as any;

    const { messagesForDB } = await processMessageImages(messages, "org-1", store, true);

    const inserts = capturedQueries.filter((q) => q.sql.includes("media_object"));
    expect(inserts).toHaveLength(2);
    inserts.forEach((q) => expect(q.sql).toContain("on conflict do nothing"));

    const dbParts = messagesForDB[0]!.content as any[];
    expect(dbParts[0]!.image_url.url).toBe(dbParts[1]!.image_url.url);
    expect(dbParts[0]!.image_url.url).toMatch(/^xinity-media:\/\/[0-9a-f]{64}$/);
  });

  test("external URL pointing to private IP is blocked by SSRF validation", async () => {
    const privateUrl = "http://127.0.0.1:9999/image.png";
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: privateUrl } }],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store, true);

    // LLM still gets the original part (fallback), DB omits the blocked image
    expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toBe(privateUrl);
    expect(messagesForDB).toHaveLength(0);
    expect(capturedQueries).toHaveLength(0);
  });

  test("text-only messages pass through without any DB or S3 calls", async () => {
    const messages = [{ role: "user", content: "Hello" }] as any;
    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store, true);
    expect(messagesForLLM).toBe(messages);
    expect(messagesForDB).toBe(messages);
    expect(capturedQueries).toHaveLength(0);
    expect(writeCall).not.toHaveBeenCalled();
  });
});

// ─── processMessageImages – S3 disabled ──────────────────────────────────────

describe("processMessageImages – S3 disabled (imageStore = null)", () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  test("rejects an oversize image rather than dropping it from the conversation", async () => {
    const oversize = `data:image/png;base64,${"A".repeat(56 * 1024 * 1024)}`;
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: oversize } }] },
    ] as any;

    await expect(processMessageImages(messages, "org-1", null, true)).rejects.toThrow(/over the 40MB limit/);
  });

  test("keeps an inline image, storing its bytes in the row it references", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", null, true);

    expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toBe(TINY_PNG_DATA_URI);
    expect((messagesForDB[0]!.content as any[])[0]!.image_url.url).toMatch(/^xinity-media:\/\//);

    const [insert] = capturedQueries;
    expect(insert?.sql).toMatch(/^\s*insert/i);
    expect(insert?.params.some((p) => p instanceof Uint8Array)).toBe(true);
  });

  test("keeps both the text and the image reference", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check this out:" },
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
        ],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", null, true);

    expect((messagesForLLM[0]!.content as any[])).toHaveLength(2);
    const dbParts = messagesForDB[0]!.content as any[];
    expect(dbParts).toHaveLength(2);
    expect(dbParts[0]).toEqual({ type: "text", text: "Check this out:" });
    expect(dbParts[1].image_url.url).toMatch(/^xinity-media:\/\//);
  });

  test("external URL pointing to private IP is blocked (S3 disabled)", async () => {
    const privateUrl = "http://192.168.1.1:8080/photo.png";
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: privateUrl } }],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", null, true);

    // LLM still gets the original part (fallback), DB omits the blocked image
    expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toBe(privateUrl);
    expect(messagesForDB).toHaveLength(0);
    expect(capturedQueries).toHaveLength(0);
  });
});

// ─── reading stored media back ────────────────────────────────────────────────

describe("restoring logged images", () => {
  const DIGEST = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
  const IMAGE_BYTES = new TextEncoder().encode("png-bytes");

  function readableStore(bytes: Uint8Array | Error = IMAGE_BYTES) {
    return {
      bucket: "xinity-media",
      client: {
        file: () => ({
          arrayBuffer: async () => {
            if (bytes instanceof Error) throw bytes;
            return bytes.buffer;
          },
        }),
      },
    } as any;
  }

  const refMessage = (url: string) => ({
    role: "user",
    content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url } }],
  }) as any;

  beforeEach(() => {
    capturedQueries.length = 0;
    storedMediaRows = [];
  });

  test("resolves a stored reference to a data URI", async () => {
    storedMediaRows = [{ s3Key: `org-1/${DIGEST}`, mimeType: "image/png" }];
    const dataUri = await resolveMediaRef(DIGEST, "org-1", readableStore());
    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString("base64")}`);
  });

  test("scopes the lookup to the organization", async () => {
    storedMediaRows = [{ s3Key: `org-1/${DIGEST}`, mimeType: "image/png" }];
    await resolveMediaRef(DIGEST, "org-1", readableStore());
    expect(capturedQueries[0]?.params).toContain("org-1");
    expect(capturedQueries[0]?.params).toContain(DIGEST);
  });

  test("returns null for an object this organization never stored", async () => {
    storedMediaRows = [];
    expect(await resolveMediaRef(DIGEST, "org-1", readableStore())).toBeNull();
  });

  test("reads an image the database holds, with no S3 configured", async () => {
    storedMediaRows = [{ s3Key: null, mimeType: "image/png", bytes: IMAGE_BYTES }];
    const dataUri = await resolveMediaRef(DIGEST, "org-1", null);
    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString("base64")}`);
  });

  test("returns null when neither S3 nor the row holds the bytes", async () => {
    storedMediaRows = [{ s3Key: null, mimeType: "image/png", bytes: null }];
    expect(await resolveMediaRef(DIGEST, "org-1", null)).toBeNull();
  });

  test("returns null when the object cannot be read", async () => {
    storedMediaRows = [{ s3Key: `org-1/${DIGEST}`, mimeType: "image/png" }];
    expect(await resolveMediaRef(DIGEST, "org-1", readableStore(new Error("gone")))).toBeNull();
  });

  test("replaces a reference in a message with the image itself", async () => {
    storedMediaRows = [{ s3Key: `org-1/${DIGEST}`, mimeType: "image/png" }];
    const [message] = await restoreMessageImages([refMessage(`xinity-media://${DIGEST}`)], "org-1", readableStore());
    const parts = message!.content as any[];
    expect(parts[1].image_url.url).toStartWith("data:image/png;base64,");
  });

  // A xinity-media:// url reaching a backend is a hard error there, so it must not survive.
  test("drops an image it cannot restore, keeping the rest of the message", async () => {
    storedMediaRows = [];
    const [message] = await restoreMessageImages([refMessage(`xinity-media://${DIGEST}`)], "org-1", readableStore());
    const parts = message!.content as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: "text", text: "look" });
  });

  test("drops a message whose only content was an unrestorable image", async () => {
    storedMediaRows = [];
    const imageOnly = { role: "user", content: [{ type: "image_url", image_url: { url: `xinity-media://${DIGEST}` } }] } as any;
    expect(await restoreMessageImages([imageOnly], "org-1", readableStore())).toEqual([]);
  });

  test("leaves urls that are not references alone", async () => {
    const external = refMessage("https://example.com/cat.png");
    expect(await restoreMessageImages([external], "org-1", readableStore())).toEqual([external]);
    expect(capturedQueries).toHaveLength(0);
  });

  test("returns plain text conversations untouched, without querying", async () => {
    const messages = [{ role: "user", content: "hi" }] as any;
    expect(await restoreMessageImages(messages, "org-1", readableStore())).toBe(messages);
    expect(capturedQueries).toHaveLength(0);
  });
});

// ─── processMessageImages – call will not be logged ──────────────────────────

describe("processMessageImages – store = false", () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  test("stores nothing for a call that will not be logged", async () => {
    const store = makeImageStore();
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }] },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store, false);

    expect(findInsert()).toBeUndefined();
    expect(store.client.write).not.toHaveBeenCalled();
    expect(messagesForDB).toEqual([]);
    // The model still needs the picture.
    expect((messagesForLLM[0] as any).content[0].image_url.url).toBe(TINY_PNG_DATA_URI);
  });

  test("still rejects an oversize image, which guards the request and not just the store", async () => {
    const oversize = `data:image/png;base64,${"A".repeat(56 * 1024 * 1024)}`;
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: oversize } }] },
    ] as any;

    await expect(processMessageImages(messages, "org-1", null, false)).rejects.toThrow(/over the 40MB limit/);
  });
});
