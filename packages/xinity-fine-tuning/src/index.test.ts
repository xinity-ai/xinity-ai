import { describe, test, expect, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { FineTuningExporter, FineTuningRunner, type RawApiCall } from "./index";

const TEST_WORK_DIR = path.join(process.cwd(), "scratch", "fine-tuning", "test-job-999");

afterEach(() => {
  if (fs.existsSync(TEST_WORK_DIR)) {
    fs.rmSync(TEST_WORK_DIR, { recursive: true, force: true });
  }
});

describe("xinity-fine-tuning", () => {
  test("FineTuningExporter exports ChatML and stringifies to JSONL", () => {
    const rawCalls: RawApiCall[] = [
      {
        id: "call-1",
        specifiedModel: "llama-3",
        inputMessages: [
          { role: "system", content: "You are a helpful AI assistant." },
          { role: "user", content: "What is 2+2?" }
        ],
        outputMessage: { role: "assistant", content: "2+2 is 4." }
      }
    ];

    const dataset = FineTuningExporter.exportChatML(rawCalls);
    expect(dataset.length).toBe(1);
    expect(dataset[0]!.messages.length).toBe(3);
    expect(dataset[0]!.messages[2]!.content).toBe("2+2 is 4.");

    const jsonl = FineTuningExporter.toJSONL(dataset);
    expect(jsonl).toContain("You are a helpful AI assistant.");
    expect(jsonl).toContain("2+2 is 4.");
  });

  test("FineTuningRunner generates Python script and initiates job", async () => {
    const script = FineTuningRunner.generatePythonScript(
      {
        jobId: "test-job-999",
        baseModel: "unsloth/llama-3.1-8b-bnb-4bit",
        datasetJsonl: '{"messages":[]}',
        learningRate: 0.0002,
        epochs: 3,
        loraRank: 16
      },
      "./dataset.jsonl",
      "./output"
    );

    expect(script).toContain("test-job-999");
    expect(script).toContain("unsloth/llama-3.1-8b-bnb-4bit");

    const status = await FineTuningRunner.startJob({
      jobId: "test-job-999",
      baseModel: "unsloth/llama-3.1-8b-bnb-4bit",
      datasetJsonl: '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]}'
    });

    expect(status.jobId).toBe("test-job-999");
    expect(["RUNNING", "QUEUED", "FAILED"]).toContain(status.status);

    const fetched = FineTuningRunner.getJobStatus("test-job-999");
    expect(fetched).toBeDefined();

    const cancelled = FineTuningRunner.cancelJob("test-job-999");
    expect(cancelled).toBe(true);
    expect(FineTuningRunner.getJobStatus("test-job-999")?.status).toBe("CANCELLED");
  });

  test("FineTuningExporter augments dataset with Code Intelligence AST Graph context when option enabled", () => {
    const rawCalls: RawApiCall[] = [
      {
        id: "call-1",
        specifiedModel: "llama-3",
        inputMessages: [{ role: "user", content: "Refactor UserService" }],
        outputMessage: { role: "assistant", content: "UserService refactored." }
      }
    ];

    const astContext = "[class] UserService @ src/service.ts\n[function] getUser @ src/service.ts";
    const dataset = FineTuningExporter.exportChatML(rawCalls, {
      includeCodeIntelligence: true,
      graphSymbolsContext: astContext
    });

    expect(dataset.length).toBe(1);
    expect(dataset[0]!.messages[0]!.role).toBe("system");
    expect(dataset[0]!.messages[0]!.content).toContain("[Code Intelligence AST Context]");
    expect(dataset[0]!.messages[0]!.content).toContain("UserService @ src/service.ts");
  });
});
