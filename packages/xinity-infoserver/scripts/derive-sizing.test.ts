import { describe, expect, test } from "bun:test";
import { deriveSizing } from "./derive-sizing";

// Config values as published on Hugging Face.
const qwen36 = {
  quantization_config: { weight_block_size: [128, 128] },
  text_config: {
    num_hidden_layers: 40, full_attention_interval: 4, num_attention_heads: 16, num_key_value_heads: 2,
    linear_num_key_heads: 16, linear_num_value_heads: 32, linear_key_head_dim: 128, linear_value_head_dim: 128,
    linear_conv_kernel_dim: 4, mamba_ssm_dtype: "float32", num_experts: 256, num_experts_per_tok: 8,
    moe_intermediate_size: 512, mtp_num_hidden_layers: 1, tie_word_embeddings: false,
  },
};

const nemotron = {
  num_hidden_layers: 88,
  hybrid_override_pattern: "MEMEMEM*EMEMEMEM*EMEMEMEM*EMEMEMEMEM*EMEMEMEMEM*EMEMEMEMEM*EMEMEMEMEM*EMEMEMEM*EMEMEMEME",
  num_attention_heads: 32, num_key_value_heads: 2,
  mamba_num_heads: 128, mamba_head_dim: 64, ssm_state_size: 128, n_groups: 8, conv_kernel: 4, mamba_ssm_cache_dtype: "float32",
};

const gemma = {
  num_hidden_layers: 42, layer_types: [...Array(35).fill("sliding_attention"), ...Array(7).fill("full_attention")],
  sliding_window: 512, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 256,
};

const whisper = { num_hidden_layers: 32, decoder_layers: 4, decoder_attention_heads: 20, max_source_positions: 1500, d_model: 1280 };

const lfm2 = { num_hidden_layers: 24, layer_types: [...Array(18).fill("conv"), ...Array(6).fill("full_attention")], conv_L_cache: 3, hidden_size: 2048 };

const tensors = [
  { name: "model.language_model.embed_tokens.weight", bytes: 1e9 },
  { name: "lm_head.weight", bytes: 1e9 },
  { name: "model.language_model.layers.0.self_attn.q_proj.weight", bytes: 2e9 },
  { name: "model.language_model.layers.0.mlp.experts.0.down_proj.weight", bytes: 32e9 },
  { name: "model.visual.blocks.0.attn.qkv.weight", bytes: 0.5e9 },
  { name: "mtp.layers.0.self_attn.q_proj.weight", bytes: 0.25e9 },
];

describe("deriveSizing", () => {
  // The catalog states the engine's padded pages, 2,162,688 bytes per Qwen3.6 layer and 4,259,840
  // per Nemotron layer. The derivation is the unpadded state the engine pads from.
  test("reproduces gated deltanet and mamba 2 state within the engine's padding", () => {
    const qwen = deriveSizing(qwen36, []);
    expect(qwen.stateBytesPerSequence! / 30).toBeGreaterThan(2162688 * 0.99);
    expect(qwen.stateBytesPerSequence! / 30).toBeLessThanOrEqual(2162688);
    const mamba = deriveSizing(nemotron, []);
    expect([mamba.attentionLayers, mamba.stateLayers]).toEqual([8, 40]);
    expect(mamba.stateBytesPerSequence! / 40).toBeGreaterThan(4259840 * 0.99);
    expect(mamba.stateBytesPerSequence! / 40).toBeLessThanOrEqual(4259840);
  });

  // As the catalog states them for Gemma 4 E4B and Whisper large v3 turbo, and LFM2's conv state in
  // vLLM's shape.
  test("counts window, cross-attention and short conv caches as sequence state", () => {
    expect(deriveSizing(gemma, [])).toMatchObject({ attentionLayers: 7, stateBytesPerSequence: 36700160 });
    expect(deriveSizing(whisper, [])).toMatchObject({ attentionLayers: 4, kvHeads: 20, stateBytesPerSequence: 30720000 });
    expect(deriveSizing(lfm2, []).stateBytesPerSequence).toBe(18 * 2048 * 2 * 2);
  });

  test("reads only the routed experts per token, and neither the embedding, the encoder nor the draft", () => {
    expect(deriveSizing(qwen36, tensors)).toMatchObject({ activeWeightGb: 4, nonLayerWeightGb: 2.5, encoderWeightGb: 0.5, draftLayers: 1 });
  });

  test("loads what the engine loads: no stored copy of a tied head, float32 at 16 bits", () => {
    const tied = { ...qwen36, text_config: { ...qwen36.text_config, tie_word_embeddings: true } };
    expect(deriveSizing(tied, tensors)).toMatchObject({ activeWeightGb: 3, nonLayerWeightGb: 1.5 });
    expect(deriveSizing({ ...whisper, torch_dtype: "float32" }, [{ name: "proj_out.weight", bytes: 2e9 }]).nonLayerWeightGb).toBe(1);
  });

  test("finds the layer stack under BERT and Whisper names", () => {
    const bert = [{ name: "roberta.embeddings.word_embeddings.weight", bytes: 1e9 }, { name: "roberta.encoder.layer.0.attention.self.query.weight", bytes: 2e9 }];
    expect(deriveSizing({ num_hidden_layers: 24, num_attention_heads: 16 }, bert).nonLayerWeightGb).toBe(1);
    const speech = [{ name: "model.encoder.layers.0.fc1.weight", bytes: 1e9 }, { name: "model.decoder.layers.0.fc1.weight", bytes: 2e9 }];
    expect(deriveSizing(whisper, speech).nonLayerWeightGb).toBe(1);
  });

  test("reports the kv heads of the full-attention layers when window layers have their own", () => {
    expect(deriveSizing({ ...gemma, num_global_key_value_heads: 1 }, []).kvHeads).toBe(1);
  });

  test("narrows the split sizes to those FP8 blocks allow", () => {
    expect(deriveSizing(qwen36, []).splitSizes).toEqual([1, 2, 4]);
  });
});
