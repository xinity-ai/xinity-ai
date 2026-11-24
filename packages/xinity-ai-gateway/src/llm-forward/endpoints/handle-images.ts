import { z } from "zod";
import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import { bytesDigest } from "common-env";
import type { StorableImageType } from "common-env/media-types";
import { errorResponse, extractAllowedRequestParams, forwardBackendError, recordUsage, rethrowIfAborted } from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { backendPostJson } from "../backend-fetch";
import type { ModelInfo } from "../model-data";
import type { AuthResult } from "../auth";
import { mediaStore, sniffImageType, storeMedia } from "../../media-store";
import { logImageCall } from "../../callLogger";
import { config } from "../../config";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "handle-images" });

const IMAGE_MODEL_TYPE = "image";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export const ImageGenerationBodySchema = z.looseObject({
  model: z.string(),
  prompt: z.string().min(1),
  n: z.int().min(1).max(10).nullish(),
  size: z.string().nullish(),
  response_format: z.enum(["b64_json", "url"]).nullish(),
  output_format: z.enum(["png", "jpeg", "webp"]).nullish(),
  output_compression: z.int().min(0).max(100).nullish(),
  background: z.enum(["transparent", "opaque", "auto"]).nullish(),
  stream: z.boolean().nullish(),
  partial_images: z.int().min(0).max(3).nullish(),
});

type ImageRequestBody = z.infer<typeof ImageGenerationBodySchema>;

function unsupportedRequest(body: ImageRequestBody): string | null {
  if (body.response_format === "url") {
    return "response_format 'url' is not supported, images are returned as b64_json";
  }
  if (body.stream || body.partial_images) {
    return "Streaming image generation is not supported";
  }
  return null;
}

function lacksTag(modelInfo: ModelInfo, tag: string): boolean {
  return modelInfo.tags !== undefined && !modelInfo.tags.includes(tag);
}

/** Everything sent to the engine besides model, prompt and input images. */
function engineRequestParams(body: ImageRequestBody, rawBody: Record<string, unknown>, modelInfo: ModelInfo): Record<string, unknown> {
  const outputFormat = body.output_format ?? "png";
  return {
    ...extractAllowedRequestParams(rawBody, modelInfo.requestParams),
    n: body.n ?? 1,
    ...(body.size && body.size !== "auto" ? { size: body.size } : {}),
    output_format: outputFormat,
    // A PNG stays uncompressed on the engine, where encoding blocks its event loop, and is compressed here instead.
    ...(outputFormat !== "png" && body.output_compression != null ? { output_compression: body.output_compression } : {}),
    ...(body.background ? { background: body.background } : {}),
  };
}

type Dimensions = { width: number; height: number };
type GeneratedImage = { bytes: Uint8Array<ArrayBuffer>; mimeType: StorableImageType; dimensions: Dimensions | null };

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  const view = viewOf(bytes);
  for (let offset = 2; offset + 9 <= bytes.length && bytes[offset] === 0xff;) {
    if (JPEG_SOF_MARKERS.has(bytes[offset + 1]!)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

const uint24At = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);

const WEBP_DIMENSIONS: Record<string, (bytes: Uint8Array) => Dimensions> = {
  "VP8 ": (bytes) => ({ width: viewOf(bytes).getUint16(26, true) & 0x3fff, height: viewOf(bytes).getUint16(28, true) & 0x3fff }),
  "VP8L": (bytes) => {
    const bits = viewOf(bytes).getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  },
  "VP8X": (bytes) => ({ width: uint24At(bytes, 24) + 1, height: uint24At(bytes, 27) + 1 }),
};

const DIMENSIONS: Partial<Record<StorableImageType, (bytes: Uint8Array) => Dimensions | null>> = {
  "image/png": (bytes) => ({ width: viewOf(bytes).getUint32(16), height: viewOf(bytes).getUint32(20) }),
  "image/jpeg": jpegDimensions,
  "image/webp": (bytes) => WEBP_DIMENSIONS[tagAt(bytes, 12)]?.(bytes) ?? null,
};

const PNG_SIGNATURE_LENGTH = 8;

type PngChunk = { type: string; data: Uint8Array };

function pngChunks(png: Uint8Array): PngChunk[] {
  const view = viewOf(png);
  const chunks: PngChunk[] = [];
  for (let offset = PNG_SIGNATURE_LENGTH; offset + 12 <= png.length;) {
    const length = view.getUint32(offset);
    chunks.push({ type: tagAt(png, offset + 4), data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

function encodePngChunk({ type, data }: PngChunk): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = viewOf(chunk);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

async function compressPng(png: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks = pngChunks(png);
  const imageData = chunks.filter((chunk) => chunk.type === "IDAT");
  if (imageData.length === 0) {
    return png;
  }
  try {
    const compressed = await deflateAsync(await inflateAsync(Buffer.concat(imageData.map((chunk) => chunk.data))));
    const before = chunks.slice(0, chunks.indexOf(imageData[0]!));
    const after = chunks.slice(before.length).filter((chunk) => chunk.type !== "IDAT");
    const rebuilt = [...before, { type: "IDAT", data: compressed }, ...after].map(encodePngChunk);
    return new Uint8Array(Buffer.concat([png.subarray(0, PNG_SIGNATURE_LENGTH), ...rebuilt]));
  } catch (err) {
    log.warn({ err }, "Could not recompress a generated PNG, keeping it as the engine sent it");
    return png;
  }
}

async function toGeneratedImage(b64: string): Promise<GeneratedImage | null> {
  const decoded = new Uint8Array(Buffer.from(b64, "base64"));
  const mimeType = sniffImageType(decoded);
  const readDimensions = mimeType && DIMENSIONS[mimeType];
  if (!mimeType || !readDimensions) {
    return null;
  }
  const bytes = mimeType === "image/png" ? await compressPng(decoded) : decoded;
  return { bytes, mimeType, dimensions: readDimensions(bytes) };
}

const BackendImagesSchema = z.looseObject({
  created: z.number(),
  data: z.array(z.looseObject({ b64_json: z.string() })).min(1),
});

async function readBackendImages(res: Response): Promise<{ created: number; images: GeneratedImage[] } | null> {
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    rethrowIfAborted(e);
    return null;
  }
  const parsed = BackendImagesSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const images = await Promise.all(parsed.data.data.map(({ b64_json }) => toGeneratedImage(b64_json)));
  return images.every((image) => image !== null) ? { created: parsed.data.created, images } : null;
}

// Diffusion transformers such as Qwen-Image, FLUX and Z-Image denoise one token per 16x16 pixel
// patch at every step, so patches times steps tracks their compute where no token count exists.
const PATCH_PIXELS = 16;

function denoisedPatches(images: GeneratedImage[], steps: number | undefined): number {
  if (steps === undefined) {
    return 0;
  }
  const patches = images.reduce((total, { dimensions }) =>
    total + (dimensions ? Math.ceil(dimensions.width / PATCH_PIXELS) * Math.ceil(dimensions.height / PATCH_PIXELS) : 0), 0);
  return patches * steps;
}

function stepsUsed(requestParams: Record<string, unknown>, modelInfo: ModelInfo): number | undefined {
  return typeof requestParams.num_inference_steps === "number" ? requestParams.num_inference_steps : modelInfo.defaultInferenceSteps;
}

type ImageCallLog = {
  auth: AuthResult;
  modelInfo: ModelInfo;
  publicSpecifier: string;
  endpoint: "images_generations" | "images_edits";
  prompt: string;
  requestParams: Record<string, unknown>;
  images: GeneratedImage[];
  durationMs: number;
};

async function logImages(call: ImageCallLog): Promise<void> {
  await Promise.all(call.images.map((image) => storeMedia(image.bytes, image.mimeType, null, call.auth.orgId, mediaStore)));
  await logImageCall({
    keyId: call.auth.keyId,
    applicationId: call.auth.applicationId,
    organizationId: call.auth.orgId,
    durationInMS: call.durationMs,
    publicSpecifier: call.publicSpecifier,
    servedModel: call.modelInfo.model,
    endpoint: call.endpoint,
    inputMessages: [{ role: "user", content: call.prompt }],
    outputMediaDigests: call.images.map((image) => bytesDigest(image.bytes)),
    requestParams: call.requestParams,
  });
}

function imagesResponse(created: number, images: GeneratedImage[], outputFormat: unknown): Response {
  const size = images[0]?.dimensions;
  return Response.json({
    created,
    data: images.map((image) => ({ b64_json: Buffer.from(image.bytes).toString("base64") })),
    output_format: outputFormat,
    ...(size ? { size: `${size.width}x${size.height}` } : {}),
  });
}

export const handleImageGeneration = withEndpointGuards({
  modelTypes: [IMAGE_MODEL_TYPE],
  bodySchema: ImageGenerationBodySchema,
  log,
  handler: async ({ auth, body, rawBody, modelInfo, originalModel, req }) => {
    const callStartTime = Date.now();
    const refusal = unsupportedRequest(body);
    if (refusal) {
      return errorResponse(refusal, 400);
    }
    if (lacksTag(modelInfo, "image_gen")) {
      return errorResponse(`Model '${originalModel}' does not generate images from a prompt alone`, 400);
    }

    const requestParams = engineRequestParams(body, rawBody, modelInfo);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(config.inference.backendTimeoutMs())]);
    const backendResponse = await backendPostJson(modelInfo, "/v1/images/generations", {
      ...requestParams,
      model: modelInfo.model,
      prompt: body.prompt,
      response_format: "b64_json",
    }, signal);
    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log, modelInfo);
    }

    const generated = await readBackendImages(backendResponse);
    if (!generated) {
      return errorResponse("Backend returned an invalid response", 502);
    }

    const shouldLog = recordUsage({
      usage: { inputTokens: 0, outputTokens: denoisedPatches(generated.images, stepsUsed(requestParams, modelInfo)) },
      auth,
      modelInfo,
      callStartTime,
      deployment: originalModel,
    });
    if (shouldLog) {
      logImages({
        auth,
        modelInfo,
        publicSpecifier: originalModel,
        endpoint: "images_generations",
        prompt: body.prompt,
        requestParams,
        images: generated.images,
        durationMs: Date.now() - callStartTime,
      }).catch((err) => log.error({ err }, "Logging an image generation failed"));
    }

    return imagesResponse(generated.created, generated.images, requestParams.output_format);
  },
});
