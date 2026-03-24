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
};

export function recordUsageEvent(record: UsageRecord): Promise<void> {
  return getDB()
    .insert(usageEventT)
    .values({
      organizationId: record.organizationId,
      applicationId: record.applicationId ?? undefined,
      apiKeyId: record.apiKeyId,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      duration: record.duration,
      logged: record.logged,
    })
    .then(() => {})
    .catch((err) => {
      log.error({ err }, "Usage recording error");
    });
}
