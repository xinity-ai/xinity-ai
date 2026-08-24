# Fine-Tuning & Distillation Pipeline

Xinity AI includes an On-Premise Fine-Tuning and Teacher-Student Distillation engine (`xinity-fine-tuning`) integrated directly into the Web Dashboard under `/training`.

## Overview

The Fine-Tuning Pipeline allows organizations to train custom LoRA / QLoRA model adapters on their own hardware using real API call logs.

### Key Capabilities

1. **Dataset Export & ChatML Ingestion**:
   - Automatically ingests labeled and rated API call logs (`apiCallT`) from PostgreSQL.
   - Formats input/output messages into standard ChatML JSONL datasets.

2. **Optional Code Intelligence AST Graph Augmentation**:
   - When enabled via the UI checkbox, the exporter fetches indexed AST graph symbols (`xinity-code-intelligence`) and injects system context into dataset samples.

3. **Unsloth & PyTorch Execution Engine**:
   - Generates standalone Python training scripts for PyTorch / Unsloth QLoRA 4-bit quantization.
   - Saves trained LoRA weights (`.safetensors` and `adapter_config.json`) for gateway hot-reloading.

4. **Web Dashboard Training Interface (`/training`)**:
   - **Dataset Overview**: Real API call counts, ChatML export counts, JSONL sample preview.
   - **Training Form**: Base model selection, learning rate, epochs, LoRA rank, GPU allocation, Code Intelligence checkbox.
   - **Job Tracking**: Real-time job table with status badges (`RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`).
   - **Live Log Console**: Real-time execution log output.
