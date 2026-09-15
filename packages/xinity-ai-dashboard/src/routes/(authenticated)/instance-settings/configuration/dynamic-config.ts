import { dynamicConfigT, sql } from "common-db";
import { getDB } from "$lib/server/db";
import {
  DYNAMIC_SETTINGS,
  findDynamicSetting,
  summarize,
  type DynamicSetting,
  type DynamicSettingSummary,
} from "./dynamic-settings";

export type DynamicOverride = {
  key: string;
  /** Withheld for secrets, which the dashboard sets but never reads back. */
  value?: string;
  updatedBy: string | null;
  updatedAt: Date;
};

export function dynamicSettings(): DynamicSettingSummary[] {
  return DYNAMIC_SETTINGS.map(summarize);
}

/**
 * Judges the value exactly as the field's own schema will. A group or cross-member rule still
 * belongs to the service, which re-resolves its whole declaration and keeps its previous values
 * when it refuses one.
 */
export function overrideProblem(setting: DynamicSetting, value: string): string | undefined {
  if (value === "") {
    return `${setting.key} cannot be empty. Clear the override instead to fall back.`;
  }
  const parsed = setting.schema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

export async function listOverrides(): Promise<DynamicOverride[]> {
  const rows = await getDB()
    .select({
      key: dynamicConfigT.key,
      value: dynamicConfigT.value,
      updatedBy: dynamicConfigT.updatedBy,
      updatedAt: dynamicConfigT.updatedAt,
    })
    .from(dynamicConfigT);

  return rows.map((row) => {
    const setting = findDynamicSetting(row.key);
    return {
      key: row.key,
      value: setting && summarize(setting).isSecret ? undefined : row.value,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  });
}

export async function setOverride(key: string, value: string, updatedBy: string | null): Promise<void> {
  await getDB()
    .insert(dynamicConfigT)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({
      target: dynamicConfigT.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
}

export async function clearOverride(key: string): Promise<void> {
  await getDB().delete(dynamicConfigT).where(sql`${dynamicConfigT.key} = ${key}`);
}
