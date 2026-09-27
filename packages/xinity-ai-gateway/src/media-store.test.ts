import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, mediaObjectT } from "common-db";

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

const { processMessageMedia, resolveMediaRef, restoreMessageMedia, sniffAudioFormat, sniffImageType } = await import("./media-store");
import type { StorableImageType } from "common-env/media-types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal 1×1 PNG, base64-encoded. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

function makeMediaStore(writeFn = mock(() => Promise.resolve())) {
  return {
    client: { write: writeFn } as any,
    bucket: "xinity-media",
  };
}

/** Find the media_object INSERT in captured queries. */
function findInsert(): CapturedQuery | undefined {
  return capturedQueries.find((q) => q.sql.includes("media_object"));
}

// ─── processMessageMedia, S3 enabled ───────────────────────────────────────

describe("processMessageMedia, S3 enabled", () => {
  let writeCall: ReturnType<typeof mock>;
  let store: ReturnType<typeof makeMediaStore>;

  beforeEach(() => {
    capturedQueries.length = 0;
    writeCall = mock(() => Promise.resolve());
    store = makeMediaStore(writeCall);
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

    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", store, true);

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

    await processMessageMedia(messages, "org-1", store, true);

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

    await processMessageMedia(messages, "org-abc", store, true);

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

    const { messagesForDB } = await processMessageMedia(messages, "org-1", store, true);

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

    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", store, true);

    // LLM still gets the original part (fallback), DB omits the blocked image
    expect((messagesForLLM[0]!.content as any[])[0]!.image_url.url).toBe(privateUrl);
    expect(messagesForDB).toHaveLength(0);
    expect(capturedQueries).toHaveLength(0);
  });

  test("text-only messages pass through without any DB or S3 calls", async () => {
    const messages = [{ role: "user", content: "Hello" }] as any;
    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", store, true);
    expect(messagesForLLM).toBe(messages);
    expect(messagesForDB).toBe(messages);
    expect(capturedQueries).toHaveLength(0);
    expect(writeCall).not.toHaveBeenCalled();
  });
});

// ─── processMessageMedia, S3 disabled ──────────────────────────────────────

describe("processMessageMedia, S3 disabled (mediaStore = null)", () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  test("rejects an oversize image rather than dropping it from the conversation", async () => {
    const oversize = `data:image/png;base64,${"A".repeat(56 * 1024 * 1024)}`;
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: oversize } }] },
    ] as any;

    await expect(processMessageMedia(messages, "org-1", null, true)).rejects.toThrow(/over the 40MB limit/);
  });

  test("keeps an inline image, storing its bytes in the row it references", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
      },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", null, true);

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

    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", null, true);

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

    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", null, true);

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
    const [message] = await restoreMessageMedia([refMessage(`xinity-media://${DIGEST}`)], "org-1", readableStore());
    const parts = message!.content as any[];
    expect(parts[1].image_url.url).toStartWith("data:image/png;base64,");
  });

  // A xinity-media:// url reaching a backend is a hard error there, so it must not survive.
  test("drops an image it cannot restore, keeping the rest of the message", async () => {
    storedMediaRows = [];
    const [message] = await restoreMessageMedia([refMessage(`xinity-media://${DIGEST}`)], "org-1", readableStore());
    const parts = message!.content as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: "text", text: "look" });
  });

  test("drops a message whose only content was an unrestorable image", async () => {
    storedMediaRows = [];
    const imageOnly = { role: "user", content: [{ type: "image_url", image_url: { url: `xinity-media://${DIGEST}` } }] } as any;
    expect(await restoreMessageMedia([imageOnly], "org-1", readableStore())).toEqual([]);
  });

  test("leaves urls that are not references alone", async () => {
    const external = refMessage("https://example.com/cat.png");
    expect(await restoreMessageMedia([external], "org-1", readableStore())).toEqual([external]);
    expect(capturedQueries).toHaveLength(0);
  });

  test("returns plain text conversations untouched, without querying", async () => {
    const messages = [{ role: "user", content: "hi" }] as any;
    expect(await restoreMessageMedia(messages, "org-1", readableStore())).toBe(messages);
    expect(capturedQueries).toHaveLength(0);
  });
});

// ─── processMessageMedia, call will not be logged ──────────────────────────

describe("processMessageMedia, store = false", () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  test("stores nothing for a call that will not be logged", async () => {
    const store = makeMediaStore();
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }] },
    ] as any;

    const { messagesForLLM, messagesForDB } = await processMessageMedia(messages, "org-1", store, false);

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

    await expect(processMessageMedia(messages, "org-1", null, false)).rejects.toThrow(/over the 40MB limit/);
  });
});

// ─── mime type is taken from the bytes ───────────────────────────────────────

describe("sniffImageType", () => {
  test("recognises the formats a model is likely to be sent", () => {
    const cases: Array<[StorableImageType, number[]]> = [
      ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
      ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
      ["image/bmp", [0x42, 0x4d, 0x00, 0x00]],
      ["image/tiff", [0x4d, 0x4d, 0x00, 0x2a]],
    ];
    for (const [expected, bytes] of cases) {
      expect(sniffImageType(new Uint8Array(bytes))).toBe(expected);
    }
  });

  test("reads the brand of a container format rather than stopping at the box", () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0];
    expect(sniffImageType(new Uint8Array([...riff, ...Buffer.from("WEBP")]))).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([0, 0, 0, 0, ...Buffer.from("ftypavif")]))).toBe("image/avif");
    expect(sniffImageType(new Uint8Array([0, 0, 0, 0, ...Buffer.from("ftypheic")]))).toBe("image/heic");
    // RIFF without the WEBP brand is some other RIFF file, not an image.
    expect(sniffImageType(new Uint8Array([...riff, ...Buffer.from("AVI ")]))).toBeNull();
  });

  test("returns null for bytes it does not recognise", () => {
    expect(sniffImageType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe("stored mime type", () => {
  let writeCall: ReturnType<typeof mock>;
  let store: ReturnType<typeof makeMediaStore>;

  beforeEach(() => {
    capturedQueries.length = 0;
    writeCall = mock(() => Promise.resolve());
    store = makeMediaStore(writeCall);
  });

  test("keeps a declared image type, even when the bytes say otherwise", async () => {
    const mislabelled = `data:image/gif;base64,${TINY_PNG_BASE64}`;
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: mislabelled } }] },
    ] as any;

    await processMessageMedia(messages, "org-1", store, true);

    expect(findInsert()!.params).toContain("image/gif");
  });

  test("falls back to the bytes when the source declared nothing usable", async () => {
    const unhelpful = `data:application/octet-stream;base64,${TINY_PNG_BASE64}`;
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: unhelpful } }] },
    ] as any;

    await processMessageMedia(messages, "org-1", store, true);

    expect(findInsert()!.params).toContain("image/png");
    expect(findInsert()!.params).not.toContain("application/octet-stream");
  });

  test("is attached to the S3 object, which is what a browser reads", async () => {
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }] },
    ] as any;

    await processMessageMedia(messages, "org-1", store, true);

    const [, , options] = writeCall.mock.calls[0] as [string, unknown, { type: string }];
    expect(options.type).toBe("image/png");
  });
});

describe("unsupported image types", () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  /** Anything a browser would execute while rendering it, since these bytes are served back. */
  const dangerous: Array<[string, string]> = [
    ["svg", `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64")}`],
    ["html", `data:text/html;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`],
    ["pdf", `data:application/pdf;base64,${Buffer.from("%PDF-1.7\n").toString("base64")}`],
  ];

  test.each(dangerous)("refuses %s rather than storing it", async (_label, url) => {
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url } }] },
    ] as any;

    await expect(processMessageMedia(messages, "org-1", makeMediaStore(), true))
      .rejects.toThrow(/not supported/);
    expect(findInsert()).toBeUndefined();
  });

  test("refuses an unrecognised type even when the call will not be logged", async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: svg } }] },
    ] as any;

    await expect(processMessageMedia(messages, "org-1", null, false))
      .rejects.toThrow(/not supported/);
  });
});

// ─── audio ───────────────────────────────────────────────────────────────────

const WAV_BYTES = new Uint8Array([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WAVEfmt ")]);
const WAV_BASE64 = Buffer.from(WAV_BYTES).toString("base64");
const audioMessage = (data: string, format = "wav") => [
  { role: "user", content: [{ type: "text", text: "listen" }, { type: "input_audio", input_audio: { data, format } }] },
] as any;

describe("sniffAudioFormat", () => {
  test("recognises wav and both ways an mp3 can start", () => {
    expect(sniffAudioFormat(WAV_BYTES)).toBe("wav");
    expect(sniffAudioFormat(new Uint8Array([...Buffer.from("ID3"), 0x04, 0x00]))).toBe("mp3");
    expect(sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe("mp3");
  });

  test("rejects lookalikes", () => {
    // ADTS shares the MPEG frame sync but is AAC.
    expect(sniffAudioFormat(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array([]))).toBeNull();
  });

  // MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames. MPEG-2 Layer III, 80 kbps, 22.05 kHz: 261-byte frames.
  const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x64];
  const MPEG2_HEADER = [0xff, 0xf3, 0x90, 0x64];
  function frames(header: number[], frameLength: number, count: number, junk = 0): Uint8Array {
    const bytes = new Uint8Array(junk + frameLength * count + 64);
    for (let i = 0; i < count; i++) {
      bytes.set(header, junk + i * frameLength);
    }
    return bytes;
  }

  test("finds the first frame behind leading junk", () => {
    expect(sniffAudioFormat(frames(MPEG1_HEADER, 417, 3, 100))).toBe("mp3");
  });

  test("works out the frame length for each MPEG version", () => {
    expect(sniffAudioFormat(frames(MPEG2_HEADER, 261, 3))).toBe("mp3");
    expect(sniffAudioFormat(frames(MPEG2_HEADER, 417, 3))).toBeNull();
  });

  test("does not take a stray sync pair in arbitrary bytes for a frame", () => {
    expect(sniffAudioFormat(frames(MPEG1_HEADER, 2000, 1, 100))).toBeNull();
  });
});

describe("processMessageMedia, audio", () => {
  let writeCall: ReturnType<typeof mock>;

  beforeEach(() => {
    capturedQueries.length = 0;
    writeCall = mock(() => Promise.resolve());
  });

  test("the model gets the base64, the log gets a reference", async () => {
    const { messagesForLLM, messagesForDB } = await processMessageMedia(audioMessage(WAV_BASE64), "org-1", makeMediaStore(writeCall), true);

    expect((messagesForLLM[0]!.content as any[])[1]).toEqual({ type: "input_audio", input_audio: { data: WAV_BASE64, format: "wav" } });
    const dbPart = (messagesForDB[0]!.content as any[])[1];
    expect(dbPart.input_audio.data).toMatch(/^xinity-media:\/\/[0-9a-f]{64}$/);
    expect(dbPart.input_audio.format).toBe("wav");
    expect(findInsert()!.params).toContain("audio/wav");
    const [, , options] = writeCall.mock.calls[0] as [string, unknown, { type: string }];
    expect(options.type).toBe("audio/wav");
  });

  test("refuses bytes that do not match the declared format", async () => {
    await expect(processMessageMedia(audioMessage(WAV_BASE64, "mp3"), "org-1", null, true))
      .rejects.toThrow("Audio data is not valid mp3");
  });

  test("refuses unrecognisable bytes, logged or not", async () => {
    const flac = Buffer.from("fLaC\0\0\0\"").toString("base64");
    await expect(processMessageMedia(audioMessage(flac), "org-1", null, true)).rejects.toThrow("not valid wav");
    await expect(processMessageMedia(audioMessage(flac), "org-1", null, false)).rejects.toThrow("not valid wav");
    expect(findInsert()).toBeUndefined();
  });

  test("refuses a format OpenAI does not accept", async () => {
    await expect(processMessageMedia(audioMessage(WAV_BASE64, "flac"), "org-1", null, false))
      .rejects.toThrow("Audio format flac is not supported. Supported: wav, mp3");
  });

  test("refuses a part without data, rather than crashing on it", async () => {
    const malformed = [{ role: "user", content: [{ type: "input_audio", input_audio: { format: "wav" } }] }] as any;
    await expect(processMessageMedia(malformed, "org-1", null, false)).rejects.toThrow(/requires a base64 data string/);
  });

  test("rejects oversize audio", async () => {
    await expect(processMessageMedia(audioMessage("A".repeat(56 * 1024 * 1024)), "org-1", null, false))
      .rejects.toThrow(/Audio is \d+ bytes, over the 40MB limit/);
  });

  test("stores nothing for a call that will not be logged", async () => {
    const store = makeMediaStore(writeCall);
    const { messagesForLLM, messagesForDB } = await processMessageMedia(audioMessage(WAV_BASE64), "org-1", store, false);

    expect(findInsert()).toBeUndefined();
    expect(writeCall).not.toHaveBeenCalled();
    expect(messagesForDB[0]!.content).toEqual([{ type: "text", text: "listen" }]);
    expect((messagesForLLM[0]!.content as any[])[1].input_audio.data).toBe(WAV_BASE64);
  });
});

describe("restoring logged audio", () => {
  const DIGEST = "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  beforeEach(() => {
    capturedQueries.length = 0;
    storedMediaRows = [];
  });

  test("replaces a reference with the stored bytes as bare base64", async () => {
    storedMediaRows = [{ s3Key: null, mimeType: "audio/wav", bytes: WAV_BYTES }];
    const [message] = await restoreMessageMedia(audioMessage(`xinity-media://${DIGEST}`), "org-1", null);
    expect((message!.content as any[])[1]).toEqual({ type: "input_audio", input_audio: { data: WAV_BASE64, format: "wav" } });
  });

  test("drops audio it cannot restore, keeping the rest of the message", async () => {
    const [message] = await restoreMessageMedia(audioMessage(`xinity-media://${DIGEST}`), "org-1", null);
    expect(message!.content).toEqual([{ type: "text", text: "listen" }]);
  });
});
