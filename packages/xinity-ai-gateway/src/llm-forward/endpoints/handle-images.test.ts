import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test, jest } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { mockBackendFetch, modelFound, requestWithParams } from "./test-helpers";
import { cache, memoryCache } from "../../cache";

import type { checkAuth as checkAuthT } from "../auth";
import type { getModelInfo as getModelInfoT, ModelInfo } from "../model-data";

const checkAuth = jest.fn<typeof checkAuthT>(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
  collectData: true,
}));
mock.module("../auth", () => ({ checkAuth }));

let mockPort = 0;
const imageModel = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  installationId: "inst-1",
  nodeId: "node-1",
  host: `localhost:${mockPort}`,
  specifier: "test-image",
  model: "engine-image",
  driver: "vllm",
  authToken: null,
  tls: false,
  type: "image",
  tags: ["image_gen"],
  requestParams: { seed: "number", num_inference_steps: "number" },
  defaultInferenceSteps: 50,
  maxContextLength: 1024,
  release: () => {},
  ...overrides,
});
const getModelInfo = jest.fn<typeof getModelInfoT>(async () => modelFound(imageModel()));
mock.module("../model-data", () => ({ getModelInfo }));

mockBackendFetch();

const recordUsageEvent = mock((_record: unknown) => {});
mock.module("../../usageRecorder", () => ({ recordUsageEvent }));

const logImageCall = mock(async (_input: unknown) => {});
const realCallLogger = await import("../../callLogger");
mock.module("../../callLogger", () => ({ ...realCallLogger, logImageCall }));

const realMediaStore = await import("../../media-store");
const storeMedia = mock(async () => "xinity-media://stored");
mock.module("../../media-store", () => ({ ...realMediaStore, storeMedia }));

const { handleImageEdit, handleImageFile, handleImageGeneration } = await import("./handle-images");

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  chunk.set(data, 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A grey RGB PNG stored without compression, the way vllm-omni writes one by default. */
function uncompressedPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let row = 0; row < height; row++) {
    rows[row * (1 + width * 3)] = 0;
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 0 })),
    pngChunk("IEND", new Uint8Array()),
  ]));
}

function pngBlob(width: number, height: number): Blob {
  return new Blob([uncompressedPng(width, height)], { type: "image/png" });
}

type MaskFormat = { colorType: 4 | 6; bitDepth: 8 | 16 };

// Rows cycle through the filter types None, Sub, Up and Average, so the gateway has to undo each.
// Opaque pixels alternate between full and nearly zero alpha, and only fully transparent ones mark the edit.
function alphaMaskBlob(width: number, height: number, transparent: (x: number, y: number) => boolean, { colorType, bitDepth }: MaskFormat = { colorType: 6, bitDepth: 8 }): Blob {
  const sampleBytes = bitDepth / 8;
  const bytesPerPixel = (colorType === 6 ? 4 : 2) * sampleBytes;
  const rowBytes = width * bytesPerPixel;
  const raw = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * rowBytes + x * bytesPerPixel;
      for (let byte = 0; byte < bytesPerPixel - sampleBytes; byte++) {
        raw[pixel + byte] = (x * 7 + y * 13 + byte * 29) & 0xff;
      }
      raw.fill(transparent(x, y) ? 0 : x % 2 ? 0xff : 0x01, pixel + bytesPerPixel - sampleBytes, pixel + bytesPerPixel);
    }
  }
  const filtered = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const filter = y % 4;
    filtered[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bytesPerPixel ? raw[y * rowBytes + x - bytesPerPixel]! : 0;
      const up = y > 0 ? raw[(y - 1) * rowBytes + x]! : 0;
      const prediction = [0, left, up, (left + up) >> 1][filter]!;
      filtered[y * (rowBytes + 1) + 1 + x] = (raw[y * rowBytes + x]! - prediction) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([bitDepth, colorType, 0, 0, 0], 8);
  return new Blob([Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(filtered)),
    pngChunk("IEND", new Uint8Array()),
  ])], { type: "image/png" });
}

function idatPixels(png: Uint8Array): Buffer {
  const length = Buffer.from(png).readUInt32BE(33);
  return inflateSync(png.subarray(41, 41 + length));
}

let server: ReturnType<typeof Bun.serve>;
let backendBodies: Record<string, unknown>[] = [];
let backendForms: Awaited<ReturnType<Request["formData"]>>[] = [];
let backendImages = [uncompressedPng(64, 32)];
const cacheSpies: { mockRestore(): void }[] = [];

beforeAll(() => {
  // The test config names a Redis that is not running.
  const inProcess = memoryCache();
  cacheSpies.push(spyOn(cache, "get").mockImplementation(inProcess.get));
  cacheSpies.push(spyOn(cache, "set").mockImplementation(inProcess.set));
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname.endsWith("/edits")) {
        backendForms.push(await req.formData());
      } else {
        backendBodies.push(await req.json() as Record<string, unknown>);
      }
      return Response.json({ created: 1700000000, data: backendImages.map((png) => ({ b64_json: Buffer.from(png).toString("base64"), url: null })) });
    },
  });
  mockPort = server.port!;
});

afterEach(() => {
  recordUsageEvent.mockClear();
  logImageCall.mockClear();
  storeMedia.mockClear();
  backendBodies = [];
  backendForms = [];
  backendImages = [uncompressedPng(64, 32)];
  checkAuth.mockImplementation(async () => ({ orgId: "org-1", keyId: "key-1", applicationId: "app-1", collectData: true }));
  getModelInfo.mockImplementation(async () => modelFound(imageModel()));
});

afterAll(() => {
  server.stop();
  cacheSpies.forEach((spy) => spy.mockRestore());
});

function generate(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return handleImageGeneration(new Request("http://localhost:4000/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": "Bearer test", ...headers },
    body: JSON.stringify({ model: "test-image", prompt: "a lighthouse", ...body }),
  }));
}

describe("handleImageGeneration", () => {
  test("returns the engine's PNG compressed, with the same pixels and its size", async () => {
    const res = await generate({});

    expect(res.status).toBe(200);
    const json = await res.json() as { data: { b64_json: string }[]; size: string; output_format: string };
    const returned = Buffer.from(json.data[0]!.b64_json, "base64");
    expect(returned.length).toBeLessThan(backendImages[0]!.length);
    expect(idatPixels(returned)).toEqual(idatPixels(backendImages[0]!));
    expect(json).toMatchObject({ size: "64x32", output_format: "png" });
  });

  test("asks the engine for uncompressed base64 PNGs at the model's default steps and forwards only allowlisted extras", async () => {
    await generate({ size: "auto", output_compression: 40, seed: 7, guidance_scale: 3 });

    expect(backendBodies[0]).toEqual({
      model: "engine-image",
      prompt: "a lighthouse",
      response_format: "b64_json",
      output_format: "png",
      n: 1,
      num_inference_steps: 50,
      seed: 7,
    });
  });

  test("records patches times the model's default steps as output tokens", async () => {
    backendImages = [uncompressedPng(64, 32), uncompressedPng(64, 32)];

    await generate({ n: 2 });

    // 4 x 2 patches per image, two images, 50 default steps.
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({ model: "test-image", inputTokens: 0, outputTokens: 2 * 8 * 50, success: true, modelType: "image" });
  });

  test("sends the model's guidance scale unless the request sets its own", async () => {
    getModelInfo.mockImplementation(async () => modelFound(imageModel({
      defaultGuidanceScale: 0,
      requestParams: { guidance_scale: "number" },
    })));

    await generate({});
    await generate({ guidance_scale: 3 });

    expect(backendBodies.map((body) => body.guidance_scale)).toEqual([0, 3]);
  });

  test("sends and counts the steps a request asked for instead of the default", async () => {
    await generate({ num_inference_steps: 4 });

    expect(backendBodies[0]).toMatchObject({ num_inference_steps: 4 });
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({ outputTokens: 8 * 4 });
  });

  test("logs the prompt, the settings sent and the stored images when the key collects data", async () => {
    await generate({ seed: 7 });
    await Bun.sleep(0);

    expect(storeMedia).toHaveBeenCalledTimes(1);
    expect(logImageCall.mock.calls[0]![0]).toMatchObject({
      endpoint: "images_generations",
      inputMessages: [{ role: "user", content: "a lighthouse" }],
      requestParams: { n: 1, output_format: "png", seed: 7 },
    });
  });

  test("stores and logs nothing when the key does not collect data", async () => {
    checkAuth.mockImplementation(async () => ({ orgId: "org-1", keyId: "key-1", applicationId: "app-1", collectData: false }));

    await generate({});
    await Bun.sleep(0);

    expect(storeMedia).not.toHaveBeenCalled();
    expect(logImageCall).not.toHaveBeenCalled();
  });

  test.each([
    ["streaming", { stream: true }],
    ["partial images", { partial_images: 2 }],
  ])("refuses %s before reaching the engine", async (_name, body) => {
    const res = await generate(body);

    expect(res.status).toBe(400);
    expect(backendBodies).toHaveLength(0);
  });

  test("returns a URL that serves the image without storing it for a key that does not collect data", async () => {
    checkAuth.mockImplementation(async () => ({ orgId: "org-1", keyId: "key-1", applicationId: "app-1", collectData: false }));

    const res = await generate({ response_format: "url" });
    const json = await res.json() as { data: { url: string; b64_json?: string }[] };
    const url = new URL(json.data[0]!.url);
    const file = await handleImageFile(requestWithParams(new Request(url.href), { fileId: url.pathname.split("/").at(-1)! }));

    expect(json.data[0]!.b64_json).toBeUndefined();
    expect(url.origin + url.pathname.replace(/[^/]+$/, "")).toBe("http://localhost:4000/media/images/");
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(idatPixels(new Uint8Array(await file.arrayBuffer()))).toEqual(idatPixels(backendImages[0]!));
    expect(storeMedia).not.toHaveBeenCalled();
  });

  test("names the reverse proxy in the URL when the request came through one", async () => {
    const res = await generate({ response_format: "url" }, { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "ai.example.com, internal:4000" });
    const json = await res.json() as { data: { url: string }[] };

    expect(json.data[0]!.url).toStartWith("https://ai.example.com/media/images/");
  });

  test("answers 404 for an unknown image URL", async () => {
    const res = await handleImageFile(requestWithParams(new Request("http://localhost:4000/media/images/nope"), { fileId: "nope" }));

    expect(res.status).toBe(404);
  });

  test("refuses a model that only edits images", async () => {
    getModelInfo.mockImplementation(async () => modelFound(imageModel({ tags: ["image_edit"] })));

    const res = await generate({});

    expect(res.status).toBe(400);
    expect(backendBodies).toHaveLength(0);
  });

  test("answers 502 when the engine returns something that is not an image", async () => {
    backendImages = [new TextEncoder().encode("not an image")];

    const res = await generate({});

    expect(res.status).toBe(502);
  });
});

function edit(fields: Record<string, string | Blob | Blob[]>, imageField = "image"): Promise<Response> {
  const form = new FormData();
  form.set("model", "test-image");
  form.set("prompt", "make it night");
  for (const [name, value] of Object.entries({ [imageField]: [pngBlob(32, 32)], ...fields })) {
    for (const part of Array.isArray(value) ? value : [value]) {
      form.append(name, part);
    }
  }
  return handleImageEdit(new Request("http://localhost:4000/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": "Bearer test" },
    body: form,
  }));
}

describe("handleImageEdit", () => {
  const editModel = () => modelFound(imageModel({ tags: ["image_edit"] }));

  test("sends every input image to the engine, with form fields read as their declared types", async () => {
    getModelInfo.mockImplementation(async () => editModel());

    const res = await edit({ "image[]": [pngBlob(16, 16), pngBlob(32, 16)], n: "2", seed: "7", guidance_scale: "3" }, "image[]");

    expect(res.status).toBe(200);
    const form = backendForms[0]!;
    expect(form.getAll("image")).toHaveLength(2);
    expect(Object.fromEntries([...form.entries()].filter(([name]) => name !== "image"))).toEqual({
      model: "engine-image",
      prompt: "make it night",
      response_format: "b64_json",
      output_format: "png",
      n: "2",
      seed: "7",
      num_inference_steps: "50",
    });
  });

  test("records the input images' patches times steps as input tokens", async () => {
    getModelInfo.mockImplementation(async () => editModel());

    await edit({ image: [pngBlob(32, 32), pngBlob(16, 16)], num_inference_steps: "4" });

    // (2 x 2 + 1) input patches and 4 x 2 output patches, at 4 steps.
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({ inputTokens: 5 * 4, outputTokens: 8 * 4 });
  });

  test("logs the prompt together with references to the stored input images", async () => {
    getModelInfo.mockImplementation(async () => editModel());

    await edit({});
    await Bun.sleep(0);

    expect(storeMedia).toHaveBeenCalledTimes(2);
    const [message] = (logImageCall.mock.calls[0]![0] as { inputMessages: { content: { type: string }[] }[] }).inputMessages;
    expect(message!.content.map((part) => part.type)).toEqual(["text", "image_url"]);
  });

  const inpaintModel = () => modelFound(imageModel({ tags: ["image_edit", "inpaint"] }));
  const lowerLeftCorner = (x: number, y: number) => x < 12 && y >= 20;

  test.each([
    ["RGBA", { colorType: 6, bitDepth: 8 }],
    ["16-bit gray and alpha", { colorType: 4, bitDepth: 16 }],
  ] as const)("sends an %s mask to the engine as white where it was fully transparent and black elsewhere", async (_name, format) => {
    getModelInfo.mockImplementation(async () => inpaintModel());

    const res = await edit({ mask: alphaMaskBlob(32, 32, lowerLeftCorner, format) });

    expect(res.status).toBe(200);
    const mask = new Uint8Array(await (backendForms[0]!.get("mask_image") as Blob).arrayBuffer());
    expect([...mask.subarray(24, 26)]).toEqual([8, 0]);
    const expectedRows = Array.from({ length: 32 }, (_, y) => [0, ...Array.from({ length: 32 }, (_, x) => lowerLeftCorner(x, y) ? 255 : 0)]);
    expect([...idatPixels(mask)]).toEqual(expectedRows.flat());
  });

  test.each([
    ["a mask without an alpha channel", { mask: pngBlob(32, 32) }],
    ["a mask that is not a PNG", { mask: new Blob(["not an image"]) }],
    ["a mask of another size than the first image", { mask: alphaMaskBlob(16, 16, lowerLeftCorner) }],
  ])("refuses %s before reaching the engine", async (_name, fields) => {
    getModelInfo.mockImplementation(async () => inpaintModel());

    const res = await edit(fields);

    expect(res.status).toBe(400);
    expect(backendForms).toHaveLength(0);
  });

  test.each([
    ["a mask for a model that does not inpaint", { mask: alphaMaskBlob(32, 32, lowerLeftCorner) }],
    ["an input that is not an image", { image: new Blob(["not an image"]) }],
    ["a missing input image", { image: [] }],
  ])("refuses %s before reaching the engine", async (_name, fields) => {
    getModelInfo.mockImplementation(async () => editModel());

    const res = await edit(fields);

    expect(res.status).toBe(400);
    expect(backendForms).toHaveLength(0);
  });

  test("refuses a model that only generates images", async () => {
    const res = await edit({});

    expect(res.status).toBe(400);
    expect(backendForms).toHaveLength(0);
  });
});
