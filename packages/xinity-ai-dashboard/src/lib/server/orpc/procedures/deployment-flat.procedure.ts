/**
 * @deprecated The deployment API as it was before deployments had types: a deployment's legacy fields sit
 * next to its shared ones. Every call forwards to its counterpart under /deployments. Removed, and
 * /deployments renamed to /deployment, once clients had time to move.
 */
import { call } from "@orpc/server";
import z from "zod";
import { DeploymentBaseDto, DeploymentBaseInputDto, LegacyDeploymentDto, LegacyDeploymentInputDto, LegacyDeploymentPatchDto, type DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import { rootOs, withOrganization, requirePermission } from "../root";
import { CapacityCheckOutput, LegacyDraftDto, deleteDeployment, deploymentsRouter, retryDeployment, toggleEnabled } from "./deployment.procedure";

const tags = ["Deployment"];
const DEPRECATION = "Deprecated: use the same call under /deployments, where a deployment's type-specific fields sit under the key of its type.";

const FlatDeploymentDto = DeploymentBaseDto.extend(LegacyDeploymentDto.shape);
const FlatDeploymentInputDto = DeploymentBaseInputDto.extend(LegacyDeploymentInputDto.shape);
const FlatDeploymentUpdateDto = DeploymentBaseInputDto.partial().extend(LegacyDeploymentPatchDto.shape).extend({ id: z.uuid() });
const FlatCapacityCheckInput = LegacyDraftDto.extend({
  deploymentId: z.uuid().optional().describe("The deployment this draft changes, which is planned without its own installations"),
});

type LegacyDeployment = Extract<DeploymentOutput, { type: "legacy" }>;

// Deployments of the other types have no flat shape, so this API does not see them.
const isLegacy = (deployment: DeploymentOutput): deployment is LegacyDeployment => deployment.type === "legacy";

function flattenLegacy(deployment: DeploymentOutput, notFound: () => Error): z.infer<typeof FlatDeploymentDto> {
  if (!isLegacy(deployment)) {
    throw notFound();
  }
  const { legacy, ...shared } = deployment;
  return { ...shared, ...legacy };
}

const flatOs = rootOs.use(withOrganization).meta({ mcp: false });
const deprecated = <T extends object>(route: T) => ({ ...route, tags, deprecated: true, description: DEPRECATION });

const listDeployments = flatOs
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route(deprecated({ path: "/", method: "GET", summary: "List Deployments" } as const))
  .input(z.object({ withStatus: z.coerce.boolean().default(false) }))
  .output(FlatDeploymentDto.array())
  .handler(async ({ context, input }) => (await call(deploymentsRouter.list, input, { context }))
    .filter(isLegacy)
    .map(({ legacy, ...shared }) => ({ ...shared, ...legacy })));

const getDeployment = flatOs
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route(deprecated({ path: "/{id}", method: "GET", summary: "Get Deployment" } as const))
  .input(z.object({ id: z.uuid(), withStatus: z.coerce.boolean().default(false) }))
  .output(FlatDeploymentDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => flattenLegacy(await call(deploymentsRouter.get, input, { context }), errors.NOT_FOUND));

const findDeployment = flatOs
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route(deprecated({ path: "/find/", method: "GET", summary: "Get Deployment by spec" } as const))
  .input(z.object({ publicSpecifier: z.string().trim() }))
  .output(FlatDeploymentDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => flattenLegacy(await call(deploymentsRouter.find, input, { context }), errors.NOT_FOUND));

const createDeployment = flatOs
  .use(requirePermission({ modelDeployment: ["create"] }))
  .route(deprecated({ path: "/", method: "POST", summary: "Create Deployment" } as const))
  .input(FlatDeploymentInputDto)
  .output(FlatDeploymentDto)
  .errors({ CONFLICT: {}, BAD_REQUEST: {}, INSUFFICIENT_CAPACITY: {}, NOT_FOUND: {} })
  .handler(async ({ context, input: { name, description, enabled, publicSpecifier, ...legacy }, errors }) =>
    flattenLegacy(await call(deploymentsRouter.create, { name, description, enabled, publicSpecifier, type: "legacy", legacy }, { context }), errors.NOT_FOUND));

const updateDeployment = flatOs
  .use(requirePermission({ modelDeployment: ["update"] }))
  .route(deprecated({ path: "/{id}", method: "PATCH", summary: "Update Deployment" } as const))
  .input(FlatDeploymentUpdateDto)
  .output(FlatDeploymentDto)
  .errors({ NOT_FOUND: {}, BAD_REQUEST: {}, INSUFFICIENT_CAPACITY: {}, CONFLICT: {} })
  .handler(async ({ context, input: { id, name, description, enabled, publicSpecifier, ...legacy }, errors }) => {
    if (!isLegacy(await call(deploymentsRouter.get, { id, withStatus: false }, { context }))) {
      throw errors.NOT_FOUND();
    }
    const updated = await call(deploymentsRouter.update, { id, name, description, enabled, publicSpecifier, legacy }, { context });
    return flattenLegacy(updated, errors.NOT_FOUND);
  });

const checkCapacity = flatOs
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route(deprecated({ path: "/check-capacity", method: "POST", summary: "Check Deployment Capacity" } as const))
  .input(FlatCapacityCheckInput)
  .output(CapacityCheckOutput)
  .handler(async ({ context, input: { deploymentId, ...legacy } }) =>
    call(deploymentsRouter.checkCapacity, { type: "legacy", deploymentId, legacy }, { context }));

export const deploymentFlatRouter = rootOs.prefix("/deployment").router({
  create: createDeployment,
  get: getDeployment,
  update: updateDeployment,
  delete: deleteDeployment.meta({ mcp: false }).route({ deprecated: true, description: DEPRECATION }),
  list: listDeployments,
  find: findDeployment,
  enable: toggleEnabled.meta({ mcp: false }).route({ deprecated: true, description: DEPRECATION }),
  retry: retryDeployment.meta({ mcp: false }).route({ deprecated: true, description: DEPRECATION }),
  checkCapacity,
});
