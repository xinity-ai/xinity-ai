import type { AnyConfig } from "./build";

export type ActivationState = "active" | "inactive" | "partial";

export type GroupActivation = {
  readonly key: string;
  readonly groupId: string;
  readonly groupTitle: string;
  readonly state: ActivationState;
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

export type ActivationWarning = GroupActivation & {
  readonly state: "partial";
  readonly message: string;
};

export type ActivationReport = {
  /** Optional groups only. A group absent from here is always present. */
  readonly byKey: ReadonlyMap<string, GroupActivation>;
  readonly warnings: readonly ActivationWarning[];
};

/** Raw values keyed by env key, before any parsing. */
export type RawPresence = Readonly<Record<string, unknown>>;

// Empty matches what parseEnv already does, so a Compose `${VAR:-}` cannot activate a group.
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function stateOf(present: number, missing: number): ActivationState {
  if (present === 0) {
    return "inactive";
  }
  if (missing === 0) {
    return "active";
  }
  return "partial";
}

function warningMessage(activation: GroupActivation): string {
  return [
    `${activation.groupTitle} is not active: some of its settings are set, but not all.`,
    `  present: ${activation.present.join(", ")}`,
    `  missing: ${activation.missing.join(", ")}`,
    "It stays off until all of them are set. If that is not what you intended, set the missing values.",
  ].join("\n");
}

export function checkGroupActivation(config: AnyConfig, raw: RawPresence): ActivationReport {
  const byKey = new Map<string, GroupActivation>();
  const warnings: ActivationWarning[] = [];

  for (const mounted of config.groups) {
    if (mounted.activation.length === 0) {
      continue;
    }

    const present = mounted.activation.filter((envKey) => isPresent(raw[envKey]));
    const missing = mounted.activation.filter((envKey) => !isPresent(raw[envKey]));
    const activation: GroupActivation = {
      key: mounted.key,
      groupId: mounted.group.id,
      groupTitle: mounted.group.title,
      state: stateOf(present.length, missing.length),
      present,
      missing,
    };

    byKey.set(mounted.key, activation);
    if (activation.state === "partial") {
      warnings.push({ ...activation, state: "partial", message: warningMessage(activation) });
    }
  }

  return { byKey, warnings };
}

export function isGroupActive(report: ActivationReport, key: string): boolean {
  const activation = report.byKey.get(key);
  return activation === undefined || activation.state === "active";
}
