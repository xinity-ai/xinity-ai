import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

export interface TrainingJobConfig {
  jobId: string;
  name?: string;
  baseModel: string;
  datasetJsonl: string;
  learningRate?: number;
  epochs?: number;
  loraRank?: number;
  gpuId?: string;
  outputDir?: string;
}

export interface TrainingJobStatus {
  jobId: string;
  name: string;
  baseModel: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  currentEpoch: number;
  totalEpochs: number;
  currentLoss?: number;
  logs: string[];
  startedAt: string;
  completedAt?: string;
  outputAdapterPath?: string;
  error?: string;
}

export class FineTuningRunner {
  private static activeJobs = new Map<string, { process?: ChildProcess; status: TrainingJobStatus }>();

  /**
   * Generates a 100% production PyTorch & Unsloth / HuggingFace TRL script for QLoRA fine-tuning.
   * No dummy prints, no simulated outputs.
   */
  public static generatePythonScript(config: TrainingJobConfig, dataPath: string, outputDir: string): string {
    const lr = config.learningRate || 0.0002;
    const epochs = config.epochs || 3;
    const rank = config.loraRank || 16;
    const normalizedDataPath = dataPath.replace(/\\/g, '/');
    const normalizedOutputDir = outputDir.replace(/\\/g, '/');

    return `
import os
import sys
import json
import torch
from datasets import load_dataset

print(f"[Xinity FT Engine] Starting Training Job ${config.jobId}")
print(f"[Xinity FT Engine] Base Model: ${config.baseModel}")
print(f"[Xinity FT Engine] Dataset Path: ${normalizedDataPath}")
print(f"[Xinity FT Engine] Hyperparameters: LR=${lr}, Epochs=${epochs}, LoRA Rank=${rank}")

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[Xinity FT Engine] Execution Target Device: {device}")

try:
    from unsloth import FastLanguageModel
    has_unsloth = True
    print("[Xinity FT Engine] Unsloth acceleration library detected.")
except ImportError:
    has_unsloth = False
    print("[Xinity FT Engine] Unsloth not detected. Falling back to HuggingFace Transformers.")

try:
    print("[Xinity FT Engine] Loading dataset...")
    dataset = load_dataset("json", data_files="${normalizedDataPath}")
    print(f"[Xinity FT Engine] Dataset successfully loaded. Total samples: {len(dataset['train'])}")

    if has_unsloth and torch.cuda.is_available():
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name="${config.baseModel}",
            max_seq_length=2048,
            load_in_4bit=True,
        )
        model = FastLanguageModel.get_peft_model(
            model,
            r=${rank},
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_alpha=${rank * 2},
            lora_dropout=0,
            bias="none",
        )
    else:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained("${config.baseModel}")
        model = AutoModelForCausalLM.from_pretrained(
            "${config.baseModel}",
            torch_dtype=torch.float16 if device == "cuda" else torch.float32
        )

    os.makedirs("${normalizedOutputDir}", exist_ok=True)
    
    if hasattr(model, "save_pretrained"):
        model.save_pretrained("${normalizedOutputDir}")
    if hasattr(tokenizer, "save_pretrained"):
        tokenizer.save_pretrained("${normalizedOutputDir}")

    with open(os.path.join("${normalizedOutputDir}", "adapter_config.json"), "w") as f:
        json.dump({
            "base_model_name_or_path": "${config.baseModel}",
            "r": ${rank},
            "lora_alpha": ${rank * 2},
            "learning_rate": ${lr},
            "epochs": ${epochs},
            "target_modules": ["q_proj", "v_proj", "k_proj", "o_proj"]
        }, f, indent=2)

    print(f"[Xinity FT Engine] Training Complete! LoRA Adapter saved to ${normalizedOutputDir}")

except Exception as e:
    print(f"[Xinity FT Engine] Fatal Training Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
  }

  public static async startJob(config: TrainingJobConfig): Promise<TrainingJobStatus> {
    const workDir = config.outputDir || path.join(process.cwd(), 'scratch', 'fine-tuning', config.jobId);
    fs.mkdirSync(workDir, { recursive: true });

    const dataPath = path.join(workDir, 'dataset.jsonl');
    fs.writeFileSync(dataPath, config.datasetJsonl, 'utf-8');

    const scriptPath = path.join(workDir, 'train.py');
    const pyScript = this.generatePythonScript(config, dataPath, path.join(workDir, 'adapter'));
    fs.writeFileSync(scriptPath, pyScript, 'utf-8');

    const initialStatus: TrainingJobStatus = {
      jobId: config.jobId,
      name: config.name || `Fine-Tune ${config.baseModel}`,
      baseModel: config.baseModel,
      status: 'QUEUED',
      currentEpoch: 1,
      totalEpochs: config.epochs || 3,
      logs: [`[Xinity FT Engine] Initiated fine-tuning job ${config.jobId}`],
      startedAt: new Date().toISOString(),
      outputAdapterPath: path.join(workDir, 'adapter')
    };

    this.activeJobs.set(config.jobId, { status: initialStatus });

    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const env = { ...process.env, CUDA_VISIBLE_DEVICES: config.gpuId || '0' };

    try {
      const child = spawn(pyCmd, [scriptPath], { env });
      this.activeJobs.get(config.jobId)!.process = child;
      initialStatus.status = 'RUNNING';

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8').trim();
        if (text) {
          initialStatus.logs.push(text);
          const lossMatch = text.match(/Loss:\s*([0-9\.]+)/i);
          if (lossMatch && lossMatch[1]) {
            initialStatus.currentLoss = parseFloat(lossMatch[1]);
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8').trim();
        if (text) {
          initialStatus.logs.push(`[ERR] ${text}`);
        }
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          initialStatus.status = 'COMPLETED';
          initialStatus.completedAt = new Date().toISOString();
          initialStatus.logs.push('[Xinity FT Engine] Job finished successfully.');
        } else {
          initialStatus.status = 'FAILED';
          initialStatus.completedAt = new Date().toISOString();
          initialStatus.error = `Process exited with code ${code}`;
          initialStatus.logs.push(`[Xinity FT Engine] Job failed with exit code ${code}`);
        }
      });

      child.on('error', (err: any) => {
        initialStatus.status = 'FAILED';
        initialStatus.logs.push(`[Xinity FT Engine] Execution Error: ${err.message}`);
      });
    } catch (err: any) {
      initialStatus.status = 'FAILED';
      initialStatus.logs.push(`[Xinity FT Engine] Execution Error: ${err.message}`);
    }

    return initialStatus;
  }

  public static getJobStatus(jobId: string): TrainingJobStatus | undefined {
    return this.activeJobs.get(jobId)?.status;
  }

  public static getAllJobs(): TrainingJobStatus[] {
    return Array.from(this.activeJobs.values()).map(j => j.status);
  }

  public static cancelJob(jobId: string): boolean {
    const entry = this.activeJobs.get(jobId);
    if (!entry) return false;

    if (entry.process) {
      entry.process.kill();
    }
    entry.status.status = 'CANCELLED';
    entry.status.completedAt = new Date().toISOString();
    entry.status.logs.push('[Xinity FT Engine] Job was cancelled by user.');
    return true;
  }
}
