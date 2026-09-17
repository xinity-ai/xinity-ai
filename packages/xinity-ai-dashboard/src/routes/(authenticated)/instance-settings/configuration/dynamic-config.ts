import { dynamicConfigT, sql } from "common-db";
import { createSecretKeyring, SEALED_PREFIX, type SecretKeyring } from "common-env";
import { getDB } from "$lib/server/db";
import { config, configStore } from "$lib/server/config";
import {
  DYNAMIC_GROUPS,
  DYNAMIC_SETTINGS,
  isSecretKey,
  summarize,
  summarizeGroup,
  type DynamicGroup,
  type DynamicGroupSummary,
  type DynamicSetting,
  type DynamicSettingSummary,
} from "./dynamic-settings";

export type DynamicOverride = {
  key: string;
  /** Withheld for secrets, which the dashboard sets but never reads back. */
  value?: string;
  digest?: string;
  updatedBy: string | null;
  updatedAt: Date;
};

export function dynamicSettings(): DynamicSettingSummary[] {
  return DYNAMIC_SETTINGS.map(summarize);
}

/** Its own only: what another component was started with is not knowable from here. */
export function notDelegatedHere(): string[] {
  const delegated = new Set(configStore.delegatedKeys);
  return DYNAMIC_SETTINGS
    .filter((setting) => setting.components.includes("dashboard") && !delegated.has(setting.key))
    .map((setting) => setting.key);
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
      valueDigest: dynamicConfigT.valueDigest,
      updatedBy: dynamicConfigT.updatedBy,
      updatedAt: dynamicConfigT.updatedAt,
    })
    .from(dynamicConfigT);

  return rows.map((row) => {
    const withheld = isSecretKey(row.key);
    return {
      key: row.key,
      value: withheld ? undefined : row.value,
      digest: withheld ? row.valueDigest ?? undefined : undefined,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  });
}

let keyring: SecretKeyring | undefined;

/** Built on first use: at module scope this would run during the CLI's build-time router import. */
function secretKeyring(): SecretKeyring {
  keyring ??= createSecretKeyring({ current: config.secretKey, previous: config.previousSecretKey });
  return keyring;
}

export async function setOverride(
  setting: DynamicSetting,
  value: string,
  updatedBy: string | null,
): Promise<void> {
  const ring = summarize(setting).isSecret ? secretKeyring() : null;
  const row = ring === null
    ? { value, valueDigest: null }
    : { value: ring.seal(value), valueDigest: ring.digest(value) };

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

export function dynamicGroups(): DynamicGroupSummary[] {
  return DYNAMIC_GROUPS.map(summarizeGroup);
}

/** Judges the members together, which is the whole reason they are a group. */
export function groupProblem(group: DynamicGroup, values: Record<string, string>): string | undefined {
  const missing = group.members.filter((member) => !values[member.key]);
  if (missing.length > 0) {
    return `${missing.map((member) => member.key).join(" and ")} must be set together with the rest of ${group.title}.`;
  }

  const sealed = group.members.find((member) => values[member.key]!.startsWith(SEALED_PREFIX));
  if (sealed) {
    return `${sealed.key} cannot start with "${SEALED_PREFIX}", which marks a value this dashboard encrypted.`;
  }

  const parsed = group.schema.safeParse(
    Object.fromEntries(group.members.map((member) => [member.name, values[member.key]])),
  );
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

/** One transaction, so no reader can see a provider that disagrees with its credential. */
export async function setGroupOverride(
  group: DynamicGroup,
  values: Record<string, string>,
  updatedBy: string | null,
): Promise<void> {
  await getDB().transaction(async (tx) => {
    for (const member of group.members) {
      const ring = isSecretKey(member.key) ? secretKeyring() : null;
      const value = values[member.key]!;
      const row = ring === null
        ? { value, valueDigest: null }
        : { value: ring.seal(value), valueDigest: ring.digest(value) };

      await tx
        .insert(dynamicConfigT)
        .values({ key: member.key, updatedBy, ...row })
        .onConflictDoUpdate({
          target: dynamicConfigT.key,
          set: { ...row, updatedBy, updatedAt: new Date() },
        });
    }
  });
}

export async function clearGroupOverride(group: DynamicGroup): Promise<void> {
  const keys = group.members.map((member) => member.key);
  await getDB().delete(dynamicConfigT).where(sql`${dynamicConfigT.key} = ANY(${keys})`);
}

/** What the audit trail may record: a secret's value is withheld there exactly as it is on read. */
export function auditableValue(key: string, value: string): string | undefined {
  return isSecretKey(key) ? undefined : value;
}
