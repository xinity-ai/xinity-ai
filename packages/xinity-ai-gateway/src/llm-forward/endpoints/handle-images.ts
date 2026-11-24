import { z } from "zod";
import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import { bytesDigest } from "common-env";
import { formatMediaRef } from "common-env/media-ref";
import type { StorableImageType } from "common-env/media-types";
import { errorResponse, extractAllowedRequestParams, forwardBackendError, recordUsage, rethrowIfAborted } from "../util";
import { pathParam, withEndpointGuards } from "../endpoint-guards";
import { backendPostForm, backendPostJson } from "../backend-fetch";
import type { ModelInfo } from "../model-data";
import type { AuthResult } from "../auth";
import { mediaStore, sniffImageType, storeMedia } from "../../media-store";
import { logImageCall } from "../../callLogger";
import { config } from "../../config";
import { cache } from "../../cache";
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
type DecodedImage = { bytes: Uint8Array<ArrayBuffer>; mimeType: StorableImageType; dimensions: Dimensions | null };

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

function decodeImage(bytes: Uint8Array<ArrayBuffer>): DecodedImage | null {
  const mimeType = sniffImageType(bytes);
  const readDimensions = mimeType && DIMENSIONS[mimeType];
  if (!mimeType || !readDimensions) {
    return null;
  }
  return { bytes, mimeType, dimensions: readDimensions(bytes) };
}

async function toGeneratedImage(b64: string): Promise<DecodedImage | null> {
  const decoded = new Uint8Array(Buffer.from(b64, "base64"));
  return decodeImage(sniffImageType(decoded) === "image/png" ? await compressPng(decoded) : decoded);
}

const BackendImagesSchema = z.looseObject({
  created: z.number(),
  data: z.array(z.looseObject({ b64_json: z.string() })).min(1),
});

async function readBackendImages(res: Response): Promise<{ created: number; images: DecodedImage[] } | null> {
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

function denoisedPatches(images: DecodedImage[], steps: number | undefined): number {
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

type ImageCall = {
  auth: AuthResult;
  modelInfo: ModelInfo;
  originalModel: string;
  endpoint: "images_generations" | "images_edits";
  prompt: string;
  inputImages: DecodedImage[];
  requestParams: Record<string, unknown>;
  callStartTime: number;
  responseFormat: ResponseFormat;
  origin: string;
};

type ResponseFormat = NonNullable<ImageRequestBody["response_format"]>;

const IMAGE_FILE_TTL_SECONDS = 60 * 60;
const IMAGE_FILE_CACHE_PREFIX = "image-file:";

type CachedImageFile = { mimeType: string; data: string };

// Behind a reverse proxy the URL has to name the proxy, which the request only knows from its headers.
function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const forwarded = (name: string) => req.headers.get(name)?.split(",")[0]?.trim() || undefined;
  return `${forwarded("x-forwarded-proto") ?? url.protocol.slice(0, -1)}://${forwarded("x-forwarded-host") ?? url.host}`;
}

// Cached rather than stored, so a URL never persists an image the caller's data collection setting keeps out of the call log.
async function cacheImageFile(image: DecodedImage, origin: string): Promise<string> {
  const fileId = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const file: CachedImageFile = { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString("base64") };
  await cache.set(`${IMAGE_FILE_CACHE_PREFIX}${fileId}`, JSON.stringify(file), IMAGE_FILE_TTL_SECONDS);
  return `${origin}/media/images/${fileId}`;
}

const IMAGE_DELIVERY: Record<ResponseFormat, (image: DecodedImage, origin: string) => Promise<{ b64_json: string } | { url: string }>> = {
  b64_json: async (image) => ({ b64_json: Buffer.from(image.bytes).toString("base64") }),
  url: async (image, origin) => ({ url: await cacheImageFile(image, origin) }),
};

export async function handleImageFile(req: Request): Promise<Response> {
  const fileId = pathParam(req, "fileId");
  const cached = fileId ? await cache.get(`${IMAGE_FILE_CACHE_PREFIX}${fileId}`) : undefined;
  if (!cached) {
    return errorResponse("Image not found or expired", 404);
  }
  const file: CachedImageFile = JSON.parse(cached);
  return new Response(Buffer.from(file.data, "base64"), { headers: { "Content-Type": file.mimeType } });
}

async function logImages(call: ImageCall, outputImages: DecodedImage[]): Promise<void> {
  const images = [...call.inputImages, ...outputImages];
  await Promise.all(images.map((image) => storeMedia(image.bytes, image.mimeType, null, call.auth.orgId, mediaStore)));
  const imageParts = call.inputImages.map((image) => ({ type: "image_url" as const, image_url: { url: formatMediaRef(bytesDigest(image.bytes)) } }));
  await logImageCall({
    keyId: call.auth.keyId,
    applicationId: call.auth.applicationId,
    organizationId: call.auth.orgId,
    durationInMS: Date.now() - call.callStartTime,
    publicSpecifier: call.originalModel,
    servedModel: call.modelInfo.model,
    endpoint: call.endpoint,
    inputMessages: [{ role: "user", content: imageParts.length > 0 ? [{ type: "text", text: call.prompt }, ...imageParts] : call.prompt }],
    outputMediaDigests: outputImages.map((image) => bytesDigest(image.bytes)),
    requestParams: call.requestParams,
  });
}

async function respondWithImages(call: ImageCall, backendResponse: Response): Promise<Response> {
  if (!backendResponse.ok) {
    return forwardBackendError(backendResponse, log, call.modelInfo);
  }
  const generated = await readBackendImages(backendResponse);
  if (!generated) {
    return errorResponse("Backend returned an invalid response", 502);
  }

  const steps = stepsUsed(call.requestParams, call.modelInfo);
  const shouldLog = recordUsage({
    usage: { inputTokens: denoisedPatches(call.inputImages, steps), outputTokens: denoisedPatches(generated.images, steps) },
    auth: call.auth,
    modelInfo: call.modelInfo,
    callStartTime: call.callStartTime,
  });
  if (shouldLog) {
    logImages(call, generated.images).catch((err) => log.error({ err, endpoint: call.endpoint }, "Logging an image call failed"));
  }

  const size = generated.images[0]?.dimensions;
  return Response.json({
    created: generated.created,
    data: await Promise.all(generated.images.map((image) => IMAGE_DELIVERY[call.responseFormat](image, call.origin))),
    output_format: call.requestParams.output_format,
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
    return respondWithImages({
      auth, modelInfo, originalModel, endpoint: "images_generations", prompt: body.prompt, inputImages: [], requestParams, callStartTime,
      responseFormat: body.response_format ?? "b64_json", origin: requestOrigin(req),
    }, backendResponse);
  },
});

const formNumber = z.coerce.number().int();

export const ImageEditBodySchema = ImageGenerationBodySchema.extend({
  image: z.array(z.instanceof(Blob)).min(1),
  mask: z.instanceof(Blob).nullish(),
  n: formNumber.min(1).max(10).nullish(),
  output_compression: formNumber.min(0).max(100).nullish(),
  stream: z.stringbool().nullish(),
  partial_images: formNumber.min(0).max(3).nullish(),
});

// The OpenAI SDKs send an array field as repeated `name[]` parts.
async function readEditForm(req: Request): Promise<Record<string, unknown> | Response> {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return errorResponse("Expected a multipart/form-data body", 400);
  }
  const body: Record<string, unknown> = { image: [] };
  for (const [key, value] of form.entries()) {
    const name = key.endsWith("[]") ? key.slice(0, -2) : key;
    if (name === "image") {
      (body.image as unknown[]).push(value);
    } else {
      body[name] = value;
    }
  }
  return body;
}

const FORM_VALUE_PARSERS: Record<string, (value: string) => unknown> = {
  number: Number,
  boolean: (value) => value === "true",
  string: (value) => value,
};

// Form fields arrive as text, so an allowlisted extra is read as the type the catalog declares for it.
function typedFormParams(rawBody: Record<string, unknown>, allowed: Record<string, string> | undefined): Record<string, unknown> {
  const typed: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(allowed ?? {})) {
    const value = rawBody[name];
    const parse = FORM_VALUE_PARSERS[type];
    if (typeof value === "string" && parse) {
      typed[name] = parse(value);
    }
  }
  return typed;
}

function engineForm(fields: Record<string, unknown>, images: DecodedImage[]): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const [index, image] of images.entries()) {
    form.append("image", new Blob([image.bytes], { type: image.mimeType }), `image-${index}`);
  }
  return form;
}

export const handleImageEdit = withEndpointGuards({
  modelTypes: [IMAGE_MODEL_TYPE],
  bodySchema: ImageEditBodySchema,
  readBody: readEditForm,
  log,
  handler: async ({ auth, body, rawBody, modelInfo, originalModel, req }) => {
    const callStartTime = Date.now();
    const refusal = unsupportedRequest(body);
    if (refusal) {
      return errorResponse(refusal, 400);
    }
    if (body.mask) {
      return errorResponse("mask is not supported", 400);
    }
    if (lacksTag(modelInfo, "image_edit")) {
      return errorResponse(`Model '${originalModel}' does not edit images`, 400);
    }

    const inputImages = await Promise.all(body.image.map(async (file) => decodeImage(new Uint8Array(await file.arrayBuffer()))));
    if (!inputImages.every((image) => image !== null)) {
      return errorResponse("Input images must be PNG, JPEG or WebP", 400);
    }

    const requestParams = engineRequestParams(body, typedFormParams(rawBody, modelInfo.requestParams), modelInfo);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(config.inference.backendTimeoutMs())]);
    const form = engineForm({ ...requestParams, model: modelInfo.model, prompt: body.prompt, response_format: "b64_json" }, inputImages);
    const backendResponse = await backendPostForm(modelInfo, "/v1/images/edits", form, signal);
    return respondWithImages({
      auth, modelInfo, originalModel, endpoint: "images_edits", prompt: body.prompt, inputImages, requestParams, callStartTime,
      responseFormat: body.response_format ?? "b64_json", origin: requestOrigin(req),
    }, backendResponse);
  },
});
