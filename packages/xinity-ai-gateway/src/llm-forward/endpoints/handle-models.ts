import { deploymentT, organizationT, sql } from "common-db";
import { getDB } from "../../db";
import { checkAuth } from "../auth";
import { GATEWAY_DEPLOYMENT_TYPES } from "../deployment-types";

const TRUTHY_QUERY_VALUES = new Set(["true", "1"]);

export async function handleModelsRequest(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) {
    return authCheckResponse;
  }
  const { orgId } = authCheckResponse;

  const includeUnavailable = TRUTHY_QUERY_VALUES.has(
    (new URL(req.url).searchParams.get("include_unavailable") ?? "").toLowerCase(),
  );

  const [orgRows, entries] = await Promise.all([
    getDB().select().from(organizationT).where(sql`${organizationT.id} = ${orgId}`).limit(1),
    getDB().select().from(deploymentT).where(sql`
      ${deploymentT.organizationId} = ${orgId}
    AND
      ${deploymentT.enabled}
    AND
      ${deploymentT.deletedAt} IS NULL
    `),
  ]);
  const [organization] = orgRows;

  const descriptionsByType = await Promise.all(
    [...Map.groupBy(entries, (entry) => entry.type)].map(([type, ofType]) => GATEWAY_DEPLOYMENT_TYPES[type].describe(ofType)),
  );
  const descriptions = new Map(descriptionsByType.flatMap((byEntry) => [...byEntry]));

  const modelOutput = entries.flatMap((entry) => {
    const description = descriptions.get(entry.id);
    if (!description) {
      return [];
    }
    return [{
      id: entry.publicSpecifier,
      object: "model",
      created: Math.floor(entry.createdAt.valueOf() / 1000),
      owned_by: organization?.slug || "organization",
      status: description.status,
      canary: description.canary,
      max_model_len: description.maxModelLen,
    }];
  });
  const visibleModels = includeUnavailable
    ? modelOutput
    : modelOutput.filter(model => model.status === "ready");

  return Response.json({ object: "list", data: visibleModels });
}
