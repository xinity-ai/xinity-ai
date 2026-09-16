import { z } from "zod";
import { rootOs, withInstanceAdmin, auditMiddleware } from "../root";
import {
  clearOverride,
  dynamicSettings,
  listOverrides,
  notDelegatedHere,
  missingSecretKey,
  overrideProblem,
  setOverride,
} from "../../../../routes/(authenticated)/instance-settings/configuration/dynamic-config";
import { findDynamicSetting } from "../../../../routes/(authenticated)/instance-settings/configuration/dynamic-settings";

const tags = ["Dynamic Configuration"];

const list = rootOs
  .use(withInstanceAdmin)
  .route({ method: "GET", path: "/dynamic-config", tags, summary: "List dashboard-managed settings" })
  .handler(async () => ({
    settings: dynamicSettings(),
    overrides: await listOverrides(),
    notDelegatedHere: notDelegatedHere(),
  }));

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

export const dynamicConfigRouter = { list, set, clear };
