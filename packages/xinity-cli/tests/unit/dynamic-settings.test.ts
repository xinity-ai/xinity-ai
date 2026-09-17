import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ConfigEntry } from "common-env";
import { DYNAMIC_GROUPS, DYNAMIC_SETTINGS } from "xinity-ai-dashboard/src/routes/(authenticated)/instance-settings/configuration/dynamic-settings.ts";
import { webSearchPairSchema } from "xinity-ai-gateway/src/llm-forward/tools/search-providers.ts";
import { DAEMON_DYNAMIC_KEYS } from "xinity-tether/src/daemon-config-keys.ts";
import { COMPONENTS, COMPONENT_CONFIGS } from "../../src/lib/component-meta.ts";

type DeclaredField = { components: string[]; group?: string; entry: ConfigEntry };

function declaredDynamicFields(): Map<string, DeclaredField> {
  const byKey = new Map<string, DeclaredField>();

  for (const component of COMPONENTS) {
    for (const entry of COMPONENT_CONFIGS[component].entries) {
      if (!entry.isDynamic) {
        continue;
      }
      const existing = byKey.get(entry.envKey);
      if (existing) {
        existing.components.push(component);
        continue;
      }
      byKey.set(entry.envKey, { components: [component], group: entry.groupTitle, entry });
    }
  }
  return byKey;
}

const shapeOf = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "output" });

describe("the dashboard's dynamic settings catalogue", () => {
  test("lists exactly the fields the services declare dynamic", () => {
    const declared = [...declaredDynamicFields().keys()].sort();
    const published = [
      ...DYNAMIC_SETTINGS.map((setting) => setting.key),
      ...DYNAMIC_GROUPS.flatMap((group) => group.members.map((member) => member.key)),
    ].sort();

    expect(published).toEqual(declared);
  });

  test("carries a schema that accepts and rejects what the declared one does", () => {
    const declared = declaredDynamicFields();

    for (const setting of DYNAMIC_SETTINGS) {
      const field = declared.get(setting.key);
      expect(field, `${setting.key} is published but not declared`).toBeDefined();
      expect(shapeOf(setting.schema), setting.key).toEqual(shapeOf(field!.entry.schema));
    }
  });

  test("attributes each setting to the components that read it", () => {
    const declared = declaredDynamicFields();

    for (const setting of DYNAMIC_SETTINGS) {
      const field = declared.get(setting.key)!;
      expect([setting.components, setting.group], setting.key)
        .toEqual([field.components, field.group]);
    }
  });
});

describe("the tether's daemon key list", () => {
  test("names exactly the keys the daemon declares dynamic", () => {
    const declared = COMPONENT_CONFIGS.daemon.entries
      .filter((entry) => entry.isDynamic)
      .map((entry) => entry.envKey);

    expect([...DAEMON_DYNAMIC_KEYS]).toEqual(declared);
  });
});

describe("the dashboard's dynamic groups", () => {
  test("hold keys the services declare dynamic, and none that are also listed singly", () => {
    const declared = declaredDynamicFields();
    const singles = new Set(DYNAMIC_SETTINGS.map((setting) => setting.key));

    for (const group of DYNAMIC_GROUPS) {
      for (const member of group.members) {
        expect(declared.get(member.key), `${member.key} is grouped but not declared dynamic`).toBeDefined();
        expect(singles.has(member.key), `${member.key} is both grouped and listed singly`).toBe(false);
      }
    }
  });

  test("judge a pair exactly as the service that reads it does", () => {
    const webSearch = DYNAMIC_GROUPS.find((group) => group.id === "webSearch")!;
    expect(shapeOf(webSearch.schema)).toEqual(shapeOf(webSearchPairSchema));
  });
});
