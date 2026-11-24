import { afterAll, afterEach, beforeAll, describe, expect, mock, test, jest } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { mockBackendFetch, modelFound } from "./test-helpers";

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

const { handleImageGeneration } = await import("./handle-images");

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  chunk.set(data, 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A grey RGB PNG stored without compression, the way vllm-omni writes one by default. */
function uncompressedPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let row = 0; row < height; row++) {
    rows[row * (1 + width * 3)] = 0;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 0 })),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function idatPixels(png: Buffer): Buffer {
  const length = png.readUInt32BE(33);
  return inflateSync(png.subarray(41, 41 + length));
}

let server: ReturnType<typeof Bun.serve>;
let backendBodies: Record<string, unknown>[] = [];
let backendImages = [uncompressedPng(64, 32)];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      backendBodies.push(await req.json() as Record<string, unknown>);
      return Response.json({ created: 1700000000, data: backendImages.map((png) => ({ b64_json: png.toString("base64"), url: null })) });
    },
  });
  mockPort = server.port!;
});

afterEach(() => {
  recordUsageEvent.mockClear();
  logImageCall.mockClear();
  storeMedia.mockClear();
  backendBodies = [];
  backendImages = [uncompressedPng(64, 32)];
  checkAuth.mockImplementation(async () => ({ orgId: "org-1", keyId: "key-1", applicationId: "app-1", collectData: true }));
  getModelInfo.mockImplementation(async () => modelFound(imageModel()));
});

afterAll(() => {
  server.stop();
});

function generate(body: Record<string, unknown>): Promise<Response> {
  return handleImageGeneration(new Request("http://localhost:4000/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": "Bearer test" },
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

  test("asks the engine for uncompressed base64 PNGs and forwards only allowlisted extras", async () => {
    await generate({ size: "auto", output_compression: 40, seed: 7, guidance_scale: 3 });

    expect(backendBodies[0]).toEqual({
      model: "engine-image",
      prompt: "a lighthouse",
      response_format: "b64_json",
      output_format: "png",
      n: 1,
      seed: 7,
    });
  });

  test("records patches times the model's default steps as output tokens", async () => {
    backendImages = [uncompressedPng(64, 32), uncompressedPng(64, 32)];

    await generate({ n: 2 });

    // 4 x 2 patches per image, two images, 50 default steps.
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({ inputTokens: 0, outputTokens: 2 * 8 * 50, success: true });
  });

  test("counts the steps a request asked for instead of the default", async () => {
    await generate({ num_inference_steps: 4 });

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
    ["a url response", { response_format: "url" }],
    ["streaming", { stream: true }],
    ["partial images", { partial_images: 2 }],
  ])("refuses %s before reaching the engine", async (_name, body) => {
    const res = await generate(body);

    expect(res.status).toBe(400);
    expect(backendBodies).toHaveLength(0);
  });

  test("refuses a model that only edits images", async () => {
    getModelInfo.mockImplementation(async () => modelFound(imageModel({ tags: ["image_edit"] })));

    const res = await generate({});

    expect(res.status).toBe(400);
    expect(backendBodies).toHaveLength(0);
  });

  test("answers 502 when the engine returns something that is not an image", async () => {
    backendImages = [Buffer.from("not an image")];

    const res = await generate({});

    expect(res.status).toBe(502);
  });
});
