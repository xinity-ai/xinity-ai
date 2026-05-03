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

mock.module("./logger", () => ({
  rootLogger: {
    child: () => ({
      debug: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

const db = drizzle.mock();
type CapturedQuery = { sql: string; params: unknown[] };
const capturedQueries: CapturedQuery[] = [];
const preparedProto = Object.getPrototypeOf(db.select().from(mediaObjectT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  return [];
});

mock.module("./db", () => ({
  getDB: () => db,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

const { processMessageImages, parseMediaRef, createImageStore } = await import("./image-store");

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

// ─── parseMediaRef ────────────────────────────────────────────────────────────

describe("parseMediaRef", () => {
  test("returns sha256 from a valid xinity-media:// URL", () => {
    const sha256 = "a".repeat(64);
    expect(parseMediaRef(`xinity-media://${sha256}`)).toBe(sha256);
  });

  test("returns null for a regular URL", () => {
    expect(parseMediaRef("https://example.com/image.png")).toBeNull();
  });

  test("returns null for a data URI", () => {
    expect(parseMediaRef(TINY_PNG_DATA_URI)).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(parseMediaRef("")).toBeNull();
  });
});

// ─── createImageStore ─────────────────────────────────────────────────────────

describe("createImageStore", () => {
  test("returns null when S3_ENDPOINT is missing", () => {
    expect(createImageStore({
      S3_ENDPOINT: undefined,
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BUCKET: "xinity-media",
      S3_REGION: "us-east-1",
    })).toBeNull();
  });

  test("returns null when credentials are missing", () => {
    expect(createImageStore({
      S3_ENDPOINT: "http://localhost:8333",
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: undefined,
      S3_BUCKET: "xinity-media",
      S3_REGION: "us-east-1",
    })).toBeNull();
  });

  test("returns an ImageStore when fully configured", () => {
    const store = createImageStore({
      S3_ENDPOINT: "http://localhost:8333",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BUCKET: "xinity-media",
      S3_REGION: "us-east-1",
    });
    expect(store).not.toBeNull();
    expect(store!.bucket).toBe("xinity-media");
  });
});

// ─── processMessageImages – fast path ────────────────────────────────────────

describe("processMessageImages – no image content", () => {
  test("returns messages unchanged when no array content present", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ] as any;

    const result = await processMessageImages(messages, "org-1", null);
    expect(result.messagesForLLM).toBe(messages);
    expect(result.messagesForDB).toBe(messages);
  });
});

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

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store);

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

    await processMessageImages(messages, "org-1", store);

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

  test("data URI: originalUrl param is null", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    await processMessageImages(messages, "org-1", store);

    const q = findInsert();
    expect(q).toBeDefined();
    expect(q!.params).toContain(null);
  });

  test("data URI: S3 write uses orgId/sha256 key", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    await processMessageImages(messages, "org-abc", store);

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

    const { messagesForDB } = await processMessageImages(messages, "org-1", store);

    const inserts = capturedQueries.filter((q) => q.sql.includes("media_object"));
    expect(inserts).toHaveLength(2);
    inserts.forEach((q) => expect(q.sql).toContain("on conflict do nothing"));

    const dbParts = messagesForDB[0]!.content as any[];
    expect(dbParts[0]!.image_url.url).toBe(dbParts[1]!.image_url.url);
    expect(dbParts[0]!.image_url.url).toMatch(/^xinity-media:\/\/[0-9a-f]{64}$/);
  });

  test("external URL: LLM receives resolved data URI, DB receives xinity-media://, originalUrl stored", async () => {
    const imgBytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const imageServer = Bun.serve({
      port: 0,
      fetch: () => new Response(imgBytes, { headers: { "content-type": "image/png" } }),
    });

    const externalUrl = `http://127.0.0.1:${imageServer.port}/image.png`;
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: externalUrl } }],
      },
    ] as any;

    try {
      const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store);

      expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
      expect((messagesForDB[0]!.content as any[])[0]!.image_url.url).toMatch(/^xinity-media:\/\/[0-9a-f]{64}$/);

      const q = findInsert();
      expect(q!.params).toContain(externalUrl);
    } finally {
      imageServer.stop();
    }
  });

  test("text-only messages pass through without any DB or S3 calls", async () => {
    const messages = [{ role: "user", content: "Hello" }] as any;
    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", store);
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

  test("data URI: LLM receives data URI, DB message omitted (image-only message)", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", null);

    expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toBe(TINY_PNG_DATA_URI);
    expect(messagesForDB).toHaveLength(0);
    expect(capturedQueries).toHaveLength(0);
  });

  test("data URI + text: DB message keeps text, strips image", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check this out:" },
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
        ],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", null);

    expect((messagesForLLM[0]!.content as any[])).toHaveLength(2);
    const dbParts = messagesForDB[0]!.content as any[];
    expect(dbParts).toHaveLength(1);
    expect(dbParts[0]).toEqual({ type: "text", text: "Check this out:" });
  });

  test("external URL: LLM receives resolved data URI, DB keeps original URL, no insert", async () => {
    const imgBytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const imageServer = Bun.serve({
      port: 0,
      fetch: () => new Response(imgBytes, { headers: { "content-type": "image/png" } }),
    });

    const externalUrl = `http://127.0.0.1:${imageServer.port}/photo.png`;
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: externalUrl } }],
      },
    ] as any;

    try {
      const { messagesForLLM, messagesForDB } = await processMessageImages(messages, "org-1", null);

      expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
      expect((messagesForDB[0]!.content as any[])[0]!.image_url.url).toBe(externalUrl);
      expect(capturedQueries).toHaveLength(0);
    } finally {
      imageServer.stop();
    }
  });
});
