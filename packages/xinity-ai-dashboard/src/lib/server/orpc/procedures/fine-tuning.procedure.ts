import { rootOs, withOrganization, requirePermission, auditMiddleware } from "../root";
import { z } from "zod";
import { sql, apiCallT, type ApiCallInputMessage } from "common-db";
import { getDB } from "$lib/server/db";
import { FineTuningExporter, FineTuningRunner, type RawApiCall } from "xinity-fine-tuning";

const tags = ["Fine-Tuning"];

/** Lists datasets created from labeled API calls in the active organization. */
const listDatasets = rootOs
  .use(withOrganization)
  .use(requirePermission({ apiCall: ["read"] }))
  .route({ path: "/datasets", method: "GET", tags, summary: "List Fine-Tuning Datasets" })
  .input(z.object({ limit: z.number().optional().default(100) }))
  .handler(async ({ context, input }) => {
    const orgId = context.activeOrganizationId;

    const calls = await getDB()
      .select()
      .from(apiCallT)
      .where(sql`${apiCallT.organizationId} = ${orgId}`)
      .limit(input.limit);

    const formattedCalls: RawApiCall[] = calls.map(c => ({
      id: c.id,
      specifiedModel: c.specifiedModel || c.model || "default",
      inputMessages: (c.inputMessages as ApiCallInputMessage[]) || [],
      outputMessage: (c.outputMessage as ApiCallInputMessage) || null,
      rating: c.rating ?? null,
      metadata: (c.metadata as Record<string, any>) ?? null
    }));

    const chatMlItems = FineTuningExporter.exportChatML(formattedCalls);
    const jsonl = FineTuningExporter.toJSONL(chatMlItems);

    return {
      totalApiCalls: calls.length,
      datasetItemCount: chatMlItems.length,
      jsonlPreview: jsonl.slice(0, 1000),
      jsonlFull: jsonl
    };
  });

/** Starts a new Fine-Tuning / Distillation job. */
const startJob = rootOs
  .use(withOrganization)
  .use(requirePermission({ deployment: ["create"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "fineTuning.start_job", resource: "fineTuning" } })
  .route({ path: "/jobs", method: "POST", tags, summary: "Start Fine-Tuning Job" })
  .input(
    z.object({
      baseModel: z.string().min(1),
      learningRate: z.number().positive().optional().default(0.0002),
      epochs: z.number().int().positive().optional().default(3),
      loraRank: z.number().int().positive().optional().default(16),
      gpuId: z.string().optional().default("0")
    })
  )
  .handler(async ({ context, input }) => {
    const orgId = context.activeOrganizationId;

    const calls = await getDB()
      .select()
      .from(apiCallT)
      .where(sql`${apiCallT.organizationId} = ${orgId}`)
      .limit(1000);

    const formattedCalls: RawApiCall[] = calls.map(c => ({
      id: c.id,
      specifiedModel: c.specifiedModel || c.model || "default",
      inputMessages: (c.inputMessages as ApiCallInputMessage[]) || [],
      outputMessage: (c.outputMessage as ApiCallInputMessage) || null,
      rating: c.rating ?? null
    }));

    const chatMlItems = FineTuningExporter.exportChatML(formattedCalls);
    const jsonl = FineTuningExporter.toJSONL(chatMlItems);
    const jobId = `ft-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const status = await FineTuningRunner.startJob({
      jobId,
      name: `Fine-Tune ${input.baseModel}`,
      baseModel: input.baseModel,
      datasetJsonl: jsonl,
      learningRate: input.learningRate,
      epochs: input.epochs,
      loraRank: input.loraRank,
      gpuId: input.gpuId
    });

    return status;
  });

/** Lists all active and past fine-tuning jobs. */
const listJobs = rootOs
  .use(withOrganization)
  .use(requirePermission({ deployment: ["read"] }))
  .route({ path: "/jobs", method: "GET", tags, summary: "List Fine-Tuning Jobs" })
  .input(z.object({}))
  .handler(async () => {
    return FineTuningRunner.getAllJobs();
  });

/** Cancels a running fine-tuning job. */
const cancelJob = rootOs
  .use(withOrganization)
  .use(requirePermission({ deployment: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "fineTuning.cancel_job", resource: "fineTuning" } })
  .route({ path: "/jobs/{jobId}/cancel", method: "POST", tags, summary: "Cancel Fine-Tuning Job" })
  .input(z.object({ jobId: z.string() }))
  .handler(async ({ input }) => {
    const success = FineTuningRunner.cancelJob(input.jobId);
    return { success, jobId: input.jobId };
  });

export const fineTuningRouter = rootOs.prefix("/fine-tuning").router({
  listDatasets,
  startJob,
  listJobs,
  cancelJob
});
