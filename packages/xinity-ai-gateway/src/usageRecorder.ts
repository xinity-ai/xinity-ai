import { getDB } from "./db";
import { usageEventT } from "common-db";
import { rootLogger } from "./logger";
import { isRowRejection } from "./db-errors";

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
const pendingInserts = new Set<Promise<void>>();

export async function flushUsageEvents(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length > 0) {
    const batch = queue;
    queue = [];
    const insert = insertBatch(batch);
    pendingInserts.add(insert);
    void insert.finally(() => pendingInserts.delete(insert));
  }
  await Promise.all(pendingInserts);
}

async function insertBatch(batch: UsageRecord[]): Promise<void> {
  try {
    await getDB().insert(usageEventT).values(batch);
  } catch (batchErr) {
    if (!isRowRejection(batchErr)) {
      log.error({ err: batchErr, count: batch.length }, "Usage recording batch failed");
      return;
    }
    log.warn({ err: batchErr, count: batch.length }, "Usage recording batch rejected, falling back to individual inserts");
    for (const record of batch) {
      try {
        await getDB().insert(usageEventT).values(record);
      } catch (rowErr) {
        log.error({ err: rowErr, record }, "Usage recording individual row error");
      }
    }
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
