import { z } from "zod";
import { rootOs, withInstanceAdmin, auditMiddleware } from "../root";
import {
  clearGroupOverride,
  clearOverride,
  dynamicGroups,
  dynamicSettings,
  groupProblem,
  auditableValue,
  listOverrides,
  notDelegatedHere,
  overrideProblem,
  setGroupOverride,
  setOverride,
} from "../../../../routes/(authenticated)/instance-settings/configuration/dynamic-config";
import { findDynamicGroup, findDynamicSetting, groupOwning } from "../../../../routes/(authenticated)/instance-settings/configuration/dynamic-settings";

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
  .meta({ audit: { action: "dynamicConfig.set", resource: "dynamicConfig", resourceId: { fromInput: "id" }, captureOutput: ["values"] } })
  .route({ method: "PUT", path: "/dynamic-config/groups/{id}", tags, summary: "Set a dashboard-managed group" })
  .input(z.object({ id: z.string(), values: z.record(z.string(), z.string()) }))
  .handler(async ({ input, context, errors }) => {
    const group = findDynamicGroup(input.id);
    if (!group) {
      throw errors.BAD_REQUEST({ message: `${input.id} is not a dashboard-managed group` });
    }

    const problem = groupProblem(group, input.values);
    if (problem) {
      throw errors.BAD_REQUEST({ message: problem });
    }

    await setGroupOverride(group, input.values, context.actor.actorLabel);
    return {
      id: group.id,
      values: Object.fromEntries(
        group.members
          .map((member) => [member.key, auditableValue(member.key, input.values[member.key]!)])
          .filter(([, value]) => value !== undefined),
      ),
    };
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
  // captureOutput, not captureInput: the handler withholds a secret's value, so the audit trail
  // records what a non-secret was set to without ever carrying a secret into the log.
  .meta({ audit: { action: "dynamicConfig.set", resource: "dynamicConfig", resourceId: { fromInput: "key" }, captureOutput: ["value"] } })
  .route({ method: "PUT", path: "/dynamic-config/{key}", tags, summary: "Set a dashboard-managed setting" })
  .input(z.object({ key: z.string(), value: z.string() }))
  .handler(async ({ input, context, errors }) => {
    const setting = findDynamicSetting(input.key);
    if (!setting) {
      throw errors.BAD_REQUEST({ message: `${input.key} is not a dashboard-managed setting` });
    }

    const problem = overrideProblem(setting, input.value);
    if (problem) {
      throw errors.BAD_REQUEST({ message: problem });
    }

    await setOverride(setting, input.value, context.actor.actorLabel);
    return { key: input.key, value: auditableValue(input.key, input.value) };
  });

const clear = rootOs
  .use(withInstanceAdmin)
  .use(auditMiddleware)
  .meta({ audit: { action: "dynamicConfig.clear", resource: "dynamicConfig", resourceId: { fromInput: "key" } } })
  .route({ method: "DELETE", path: "/dynamic-config/{key}", tags, summary: "Clear a dashboard-managed setting" })
  .input(z.object({ key: z.string() }))
  .handler(async ({ input, errors }) => {
    const group = groupOwning(input.key);
    if (group) {
      throw errors.BAD_REQUEST({
        message: `${input.key} is part of ${group.title} and cannot be cleared on its own. Clear the group instead.`,
      });
    }
    if (!findDynamicSetting(input.key)) {
      throw errors.BAD_REQUEST({ message: `${input.key} is not a dashboard-managed setting` });
    }

    await clearOverride(input.key);
    return { key: input.key };
  });

export const dynamicConfigRouter = { list, set, clear, setGroup, clearGroup };
