import { dynamicConfigT, sql } from "common-db";
import { createSecretKeyring, SEALED_PREFIX, type SecretKeyring } from "common-env";
import { getDB } from "$lib/server/db";
import { config } from "$lib/server/config";
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
  if (value.startsWith(SEALED_PREFIX)) {
    return `${setting.key} cannot start with "${SEALED_PREFIX}", which marks a value this dashboard encrypted.`;
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

let keyring: SecretKeyring | null | undefined;

function secretKeyring(): SecretKeyring | null {
  if (keyring === undefined) {
    keyring = config.secretKey === undefined
      ? null
      : createSecretKeyring({ current: config.secretKey, previous: config.previousSecretKey });
  }
  return keyring;
}

export function missingSecretKey(setting: DynamicSetting): string | undefined {
  if (!summarize(setting).isSecret || secretKeyring() !== null) {
    return undefined;
  }
  return `${setting.key} is a secret, and this dashboard has no XINITY_SECRET_KEY to encrypt it with. `
    + "Set one on every host that reads it before managing this setting here.";
}

export async function setOverride(
  setting: DynamicSetting,
  value: string,
  updatedBy: string | null,
): Promise<void> {
  const ring = summarize(setting).isSecret ? secretKeyring() : null;
  const row = ring === null
    ? { value, encrypted: false, valueDigest: null }
    : { value: ring.seal(value), encrypted: true, valueDigest: ring.digest(value) };

  await getDB()
    .insert(dynamicConfigT)
    .values({ key: setting.key, updatedBy, ...row })
    .onConflictDoUpdate({
      target: dynamicConfigT.key,
      set: { ...row, updatedBy, updatedAt: new Date() },
    });
}

export async function clearOverride(key: string): Promise<void> {
  await getDB().delete(dynamicConfigT).where(sql`${dynamicConfigT.key} = ${key}`);
}
