import { asc, inArray, inferenceCallImageT, inferenceCallMediaT, mediaObjectT, sql } from "common-db";
import { formatMediaRef } from "common-env/media-ref";
import { getDB } from "$lib/server/db";

export type CallImages = {
  /** `xinity-media://` references in the order the model returned them. */
  outputs: string[];
  requestParams: Record<string, unknown>;
};

export async function resolveCallImages(callIds: string[]): Promise<Map<string, CallImages>> {
  if (callIds.length === 0) {
    return new Map();
  }

  const db = getDB();
  const [settings, outputs] = await Promise.all([
    db.select().from(inferenceCallImageT).where(inArray(inferenceCallImageT.callId, callIds)),
    db
      .select({ callId: inferenceCallMediaT.callId, sha256: mediaObjectT.sha256 })
      .from(inferenceCallMediaT)
      .innerJoin(mediaObjectT, sql`${mediaObjectT.id} = ${inferenceCallMediaT.mediaObjectId}`)
      .where(inArray(inferenceCallMediaT.callId, callIds))
      .orderBy(asc(inferenceCallMediaT.callId), asc(inferenceCallMediaT.seq)),
  ]);

  const images = new Map(settings.map((row) => [row.callId, { outputs: [] as string[], requestParams: row.requestParams }]));
  for (const output of outputs) {
    images.get(output.callId)?.outputs.push(formatMediaRef(output.sha256));
  }
  return images;
}
