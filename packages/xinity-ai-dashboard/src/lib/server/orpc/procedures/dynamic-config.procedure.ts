import { z } from "zod";
import { rootOs, withInstanceAdmin, auditMiddleware } from "../root";
import {
  clearGroupOverride,
  clearOverride,
  dynamicGroups,
  dynamicSettings,
  groupProblem,
  listOverrides,
  missingSecretKey,
  missingSecretKeyForGroup,
  notDelegatedHere,
  overrideProblem,
  setGroupOverride,
  setOverride,
} from "../../../../routes/(authenticated)/instance-settings/configuration/dynamic-config";
import { findDynamicGroup, findDynamicSetting } from "../../../../routes/(authenticated)/instance-settings/configuration/dynamic-settings";

const tags = ["Dynamic Configuration"];

const list = rootOs
  .use(withInstanceAdmin)
  .route({ method: "GET", path: "/dynamic-config", tags, summary: "List dashboard-managed settings" })
  .handler(async () => ({
    settings: dynamicSettings(),
    groups: dynamicGroups(),
    overrides: await listOverrides(),
    notDelegatedHere: notDelegatedHere(),
  }));

const setGroup = rootOs
  .use(withInstanceAdmin)
  .use(auditMiddleware)
  .meta({ audit: { action: "dynamicConfig.set", resource: "dynamicConfig", resourceId: { fromInput: "id" }, captureInput: ["id"] } })
  .route({ method: "PUT", path: "/dynamic-config/groups/{id}", tags, summary: "Set a dashboard-managed group" })
  .input(z.object({ id: z.string(), values: z.record(z.string(), z.string()) }))
  .handler(async ({ input, context, errors }) => {
    const group = findDynamicGroup(input.id);
    if (!group) {
      throw errors.BAD_REQUEST({ message: `${input.id} is not a dashboard-managed group` });
    }

    const problem = groupProblem(group, input.values) ?? missingSecretKeyForGroup(group);
    if (problem) {
      throw errors.BAD_REQUEST({ message: problem });
    }

    await setGroupOverride(group, input.values, context.actor.actorLabel);
    return { id: group.id };
  });

const clearGroup = rootOs
  .use(withInstanceAdmin)
  .use(auditMiddleware)
  .meta({ audit: { action: "dynamicConfig.clear", resource: "dynamicConfig", resourceId: { fromInput: "id" } } })
  .route({ method: "DELETE", path: "/dynamic-config/groups/{id}", tags, summary: "Clear a dashboard-managed group" })
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, errors }) => {
    const group = findDynamicGroup(input.id);
    if (!group) {
      throw errors.BAD_REQUEST({ message: `${input.id} is not a dashboard-managed group` });
    }
    await clearGroupOverride(group);
    return { id: group.id };
  });

const set = rootOs
  .use(withInstanceAdmin)
  .use(auditMiddleware)
  .meta({ audit: { action: "dynamicConfig.set", resource: "dynamicConfig", resourceId: { fromInput: "key" }, captureInput: ["key"] } })
  .route({ method: "PUT", path: "/dynamic-config/{key}", tags, summary: "Set a dashboard-managed setting" })
  .input(z.object({ key: z.string(), value: z.string() }))
  .handler(async ({ input, context, errors }) => {
    const setting = findDynamicSetting(input.key);
    if (!setting) {
      throw errors.BAD_REQUEST({ message: `${input.key} is not a dashboard-managed setting` });
    }

    const problem = overrideProblem(setting, input.value) ?? missingSecretKey(setting);
    if (problem) {
      throw errors.BAD_REQUEST({ message: problem });
    }

    await setOverride(setting, input.value, context.actor.actorLabel);
    return { key: input.key };
  });

const clear = rootOs
  .use(withInstanceAdmin)
  .use(auditMiddleware)
  .meta({ audit: { action: "dynamicConfig.clear", resource: "dynamicConfig", resourceId: { fromInput: "key" } } })
  .route({ method: "DELETE", path: "/dynamic-config/{key}", tags, summary: "Clear a dashboard-managed setting" })
  .input(z.object({ key: z.string() }))
  .handler(async ({ input }) => {
    await clearOverride(input.key);
    return { key: input.key };
  });

export const dynamicConfigRouter = { list, set, clear, setGroup, clearGroup };
