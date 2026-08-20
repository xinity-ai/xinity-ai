import { getDB } from "./db";
import { usageEventT } from "common-db";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "usage-recorder" });

type UsageRecord = {
  organizationId: string;
  applicationId: string | null;
  apiKeyId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  duration: number | null;
  logged: boolean;
  /** Node that served the request; null when none was selected. */
  nodeId: string | null;
  success: boolean;
};

const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 200;

let queue: UsageRecord[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export async function flushUsageEvents(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;

  const batch = queue;
  queue = [];

  try {
    await getDB().insert(usageEventT).values(batch);
  } catch (err) {
    log.error({ err, count: batch.length }, "Usage recording batch error");
  }
}

export function recordUsageEvent(record: UsageRecord): void {
  queue.push(record);
  if (queue.length >= BATCH_SIZE) {
    void flushUsageEvents();
  } else if (!timer) {
    timer = setTimeout(() => void flushUsageEvents(), FLUSH_INTERVAL_MS);
  }
}

process.on("beforeExit", () => {
  void flushUsageEvents();
});
