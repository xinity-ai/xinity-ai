// Usage: bun run derive-sizing <model directory or Hugging Face repo id>, HF_TOKEN for gated repos
import { existsSync } from "node:fs";
import { join } from "node:path";

type Config = Record<string, any>;
type CheckpointTensor = { name: string; bytes: number };

const ENCODER = /(^|\.)(visual|vision_tower|vision_model|vision_encoder|audio_tower|audio_model|multi_modal_projector|mm_projector|embed_vision|embed_audio)\./;
const DRAFT = /(^|\.)mtp\./;
// BERT-style encoders name their stack `layer.N`.
const LAYER = /(^|\.)layers?\.(\d+)\./;
// An encoder-decoder (Whisper) counts its encoder outside the decoder stack.
const DECODER_LAYER = /(^|\.)decoder\.layers\.(\d+)\./;
const EXPERT = /\.experts\./;
const TIED_HEAD = /(^|\.)lm_head\./;
const LOOKUP = /(embed_tokens|tok_embeddings|embeddings|wte|ngram_embedding|per_layer_embedding)/;
// vLLM keeps n-gram embedding tables in pinned host memory.
const HOST_KEPT = /ngram_embedding\./;

const LAYER_KINDS: Record<string, "attention" | "window" | "state"> = {
  full_attention: "attention", attention: "attention", "*": "attention",
  sliding_attention: "window",
  linear_attention: "state", mamba: "state", M: "state", conv: "state",
};

const stateDtypeBytes = (dtype: unknown) => (dtype === "float32" ? 4 : 2);

// Per recurrent layer and sequence, unpadded, in the shapes vLLM allocates.
const RECURRENT_STATE: { applies: (c: Config) => boolean; bytesPerLayer: (c: Config) => number }[] = [
  {
    applies: (c) => c.linear_num_value_heads !== undefined,
    bytesPerLayer: (c) => (2 * c.linear_num_key_heads * c.linear_key_head_dim + c.linear_num_value_heads * c.linear_value_head_dim) * (c.linear_conv_kernel_dim - 1) * 2
      + c.linear_num_value_heads * c.linear_key_head_dim * c.linear_value_head_dim * stateDtypeBytes(c.mamba_ssm_dtype),
  },
  {
    applies: (c) => c.mamba_num_heads !== undefined,
    bytesPerLayer: (c) => (c.mamba_num_heads * c.mamba_head_dim + 2 * c.n_groups * c.ssm_state_size) * (c.conv_kernel - 1) * 2
      + c.mamba_num_heads * c.mamba_head_dim * c.ssm_state_size * stateDtypeBytes(c.mamba_ssm_cache_dtype),
  },
  {
    applies: (c) => c.conv_L_cache !== undefined,
    bytesPerLayer: (c) => c.hidden_size * (c.conv_L_cache - 1) * 2,
  },
];

function layerKinds(c: Config): string[] {
  const types = c.layer_types ?? c.layers_block_type ?? (c.hybrid_override_pattern ? [...c.hybrid_override_pattern] : undefined);
  if (types) {
    return types.map((type: string) => LAYER_KINDS[type] ?? "other");
  }
  const interval = c.full_attention_interval;
  return Array.from({ length: c.num_hidden_layers }, (_, index) => (!interval || index % interval === interval - 1 ? "attention" : "state"));
}

const gb = (bytes: number) => Math.round(bytes / 1e7) / 100;
const sum = (tensors: CheckpointTensor[]) => tensors.reduce((total, tensor) => total + tensor.bytes, 0);

export function deriveSizing(config: Config, tensors: CheckpointTensor[]) {
  const nested: Config = config.text_config ?? config.thinker_config?.text_config ?? config;
  // Whisper-style encoder-decoders page KV in the decoder only.
  const c: Config = nested.decoder_layers === undefined
    ? nested
    : { ...nested, num_hidden_layers: nested.decoder_layers, num_attention_heads: nested.decoder_attention_heads };
  const kvHeads = c.num_key_value_heads ?? c.num_attention_heads;
  const kinds = layerKinds(c);
  const count = (kind: string) => kinds.filter((each) => each === kind).length;

  const recurrent = RECURRENT_STATE.find((family) => family.applies(c));
  const states = [
    count("state") > 0 && recurrent ? recurrent.bytesPerLayer(c) * count("state") : 0,
    count("window") > 0 ? count("window") * c.sliding_window * 2 * kvHeads * (c.head_dim ?? c.hidden_size / c.num_attention_heads) * 2 : 0,
    (c.decoder_layers ?? 0) * (c.max_source_positions ?? 0) * 2 * (c.d_model ?? 0) * 2,
  ];

  const stack = nested.decoder_layers === undefined ? LAYER : DECODER_LAYER;
  const tied = (c.tie_word_embeddings ?? config.tie_word_embeddings) === true;
  // vLLM loads a float32 checkpoint at 16 bits.
  const loadedShare = (config.torch_dtype ?? config.dtype) === "float32" ? 0.5 : 1;
  const main = tensors
    .filter((t) => !DRAFT.test(t.name) && !(tied && TIED_HEAD.test(t.name)))
    .map((t) => ({ ...t, bytes: t.bytes * loadedShare }));
  const experts = c.num_experts ?? c.num_local_experts ?? c.n_routed_experts;
  // Pruned checkpoints (Nemotron Puzzle) route a different number of experts per block.
  const routedShare = (t: CheckpointTensor) =>
    (c.block_configs?.[Number(LAYER.exec(t.name)?.[2])]?.num_experts_per_tok ?? c.num_experts_per_tok ?? c.moe_topk ?? c.top_k_experts) / experts;
  const streamed = main.filter((t) => !ENCODER.test(t.name) && !LOOKUP.test(t.name));
  const active = streamed.reduce((total, t) => total + (EXPERT.test(t.name) ? t.bytes * routedShare(t) : t.bytes), 0);

  const block = config.quantization_config?.weight_block_size?.[0];
  const splitDims = [c.intermediate_size, c.moe_intermediate_size].filter((dim) => dim !== undefined);
  const splitSizes = [1, 2, 4, 8].filter((ranks) => !block || splitDims.every((dim) => (dim / ranks) % block === 0));

  return {
    layers: kinds.length,
    attentionLayers: count("attention"),
    draftLayers: c.mtp_num_hidden_layers ?? c.num_nextn_predict_layers ?? 0,
    stateLayers: count("state") || undefined,
    attentionHeads: c.num_attention_heads,
    // Gemma 4 gives its full-attention layers fewer kv heads than its window layers.
    kvHeads: c.num_global_key_value_heads ?? kvHeads,
    stateBytesPerSequence: states.reduce((total, bytes) => total + bytes, 0) || undefined,
    unknownStateFamily: count("state") > 0 && !recurrent,
    nonLayerWeightGb: gb(sum(main.filter((t) => !stack.test(t.name) || ENCODER.test(t.name)))),
    encoderWeightGb: gb(sum(main.filter((t) => ENCODER.test(t.name)))),
    activeWeightGb: experts && main.some((t) => EXPERT.test(t.name)) ? gb(active) : undefined,
    hostWeightGb: gb(sum(main.filter((t) => HOST_KEPT.test(t.name)))),
    splitSizes: splitSizes.length < 4 ? splitSizes : undefined,
  };
}

type Readable = { arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<any> };
type Read = (file: string, range?: [number, number]) => Promise<Readable | undefined>;

const readLocal = (dir: string): Read => async (file, range) => {
  const blob = Bun.file(join(dir, file));
  if (!(await blob.exists())) {
    return undefined;
  }
  return range ? blob.slice(range[0], range[1]) : blob;
};

const readHuggingFace = (repo: string): Read => async (file, range) => {
  const response = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, {
    headers: {
      ...(process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {}),
      ...(range ? { range: `bytes=${range[0]}-${range[1] - 1}` } : {}),
    },
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${response.status} for ${repo}/${file}${response.status === 401 ? ", a gated repo needs HF_TOKEN" : ""}`);
  }
  return response;
};

async function readRequired(read: Read, file: string, range?: [number, number]): Promise<Readable> {
  const readable = await read(file, range);
  if (!readable) {
    throw new Error(`${file} not found`);
  }
  return readable;
}

async function shardNames(read: Read): Promise<string[]> {
  const index = await read("model.safetensors.index.json");
  return index ? [...new Set<string>(Object.values((await index.json()).weight_map))] : ["model.safetensors"];
}

// Only the header at the start of each shard is read, never the weights.
async function readShard(read: Read, shard: string): Promise<{ tensors: CheckpointTensor[]; bytes: number }> {
  const length = Number(new DataView(await (await readRequired(read, shard, [0, 8])).arrayBuffer()).getBigUint64(0, true));
  const header = await (await readRequired(read, shard, [8, 8 + length])).json() as Record<string, { data_offsets?: [number, number] }>;
  const offsets = Object.entries(header).flatMap(([name, { data_offsets }]) => (data_offsets ? [{ name, start: data_offsets[0], end: data_offsets[1] }] : []));
  return {
    tensors: offsets.map(({ name, start, end }) => ({ name, bytes: end - start })),
    // The file is the 8-byte length, the header, then the tensor data up to its last byte.
    bytes: 8 + length + Math.max(0, ...offsets.map(({ end }) => end)),
  };
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: bun run derive-sizing <model directory or Hugging Face repo id>");
    process.exit(1);
  }
  const read = existsSync(source) ? readLocal(source) : readHuggingFace(source);
  // One shard at a time: Hugging Face refuses connections when a repo of a hundred shards is read at once.
  const tensors: CheckpointTensor[] = [];
  let largestFileBytes = 0;
  for (const shard of await shardNames(read)) {
    const { tensors: shardTensors, bytes } = await readShard(read, shard);
    tensors.push(...shardTensors);
    largestFileBytes = Math.max(largestFileBytes, bytes);
  }
  const s = deriveSizing(await (await readRequired(read, "config.json")).json(), tensors);
  const lines = [
    `layers: ${s.layers}`,
    `attentionLayers: ${s.attentionLayers}${s.draftLayers ? `  # +${s.draftLayers} with speculative decoding` : ""}`,
    s.stateLayers && `stateLayers: ${s.stateLayers}`,
    `attentionHeads: ${s.attentionHeads}`,
    `kvHeads: ${s.kvHeads}`,
    s.stateBytesPerSequence && `stateBytesPerSequence: ${s.stateBytesPerSequence}`,
    s.unknownStateFamily && "# recurrent layers of an unknown family, measure stateBytesPerSequence",
    `nonLayerWeightGb: ${s.nonLayerWeightGb}${s.encoderWeightGb ? `  # ${s.encoderWeightGb} of it encoders, drop for a text-only entry` : ""}`,
    s.activeWeightGb && `activeWeightGb: ${s.activeWeightGb}  # measure it instead with speculative decoding`,
    s.hostWeightGb && `# hostWeightGb: ${s.hostWeightGb}, state it after a passing run across two nodes`,
    `largestFileGb: ${gb(largestFileBytes)}`,
    s.splitSizes && `# placement.limits splitSizes: [${s.splitSizes.join(", ")}], unless experts run expert parallel`,
  ];
  console.log(lines.filter(Boolean).join("\n"));
}
