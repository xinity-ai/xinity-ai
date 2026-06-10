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

export async function recordUsageEvent(record: UsageRecord): Promise<void> {
  try {
    await getDB().insert(usageEventT).values(record);
  } catch (err) {
    log.error({ err }, "Usage recording error");
  }
}
