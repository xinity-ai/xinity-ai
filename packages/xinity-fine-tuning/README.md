# Xinity Fine-Tuning & Distillation Pipeline Engine (`xinity-fine-tuning`)

The `xinity-fine-tuning` package provides an end-to-end On-Premise Fine-Tuning and Teacher-Student Distillation engine for Xinity AI.

## Architectural Overview

```text
 [ API Calls & Labeled Data ] ──► [ Dataset Exporter (JSONL) ]
                                              │
                                              ▼
 [ Target Model & GPU Config ] ──► [ Training Job Runner ]
                                              │
                                              ├─► Spawns PyTorch/Unsloth Script
                                              ├─► Tracks Loss & Metrics
                                              └─► Outputs LoRA / Safetensors Adapters
```

## Key Capabilities

1. **Dataset Ingestion & Formatting (`src/exporter.ts`)**:
   - Converts labeled API calls (`apiCallT` logs) into standard JSONL datasets (ChatML / OpenAI format).
   - Filters by ratings, positive feedback, and application categories.
   - Splits data into training (90%) and validation (10%) sets.

2. **Training Job Execution Engine (`src/runner.ts`)**:
   - Generates standalone Python training scripts using **Unsloth** / **HuggingFace TRL**.
   - Supports QLoRA 4-bit / 8-bit quantization for low-VRAM single GPU environments.
   - Manages process lifecycle (spawn, loss metrics extraction, cancellation, completion).

3. **Adapter Export & Hot-Reload Preparation**:
   - Compiles trained LoRA adapters into `.safetensors` or GGUF format ready for registration into `xinity-ai-gateway`.

## Getting Started

```typescript
import { FineTuningExporter, FineTuningRunner } from 'xinity-fine-tuning';

// 1. Export Dataset
const jsonlData = FineTuningExporter.exportChatML(apiCalls);

// 2. Start Fine-Tuning Job
const job = await FineTuningRunner.startJob({
  jobId: 'ft-job-101',
  baseModel: 'unsloth/llama-3.1-8b-bnb-4bit',
  datasetJsonl: jsonlData,
  learningRate: 0.0002,
  epochs: 3,
  loraRank: 16,
  gpuId: '0'
});
```
