import type { Component } from "svelte";
import type { z } from "zod";
import { keepsKvCache, type Engine, type ModelWithSpecifier, type NodeCapability } from "common-env/model-catalog";
import {
  MIN_CANARY_REPLICAS,
  type CanaryDeploymentPatchDto,
  type CanaryMemberInput,
  type CANARY_MEMBERS,
  type DeploymentBaseInputDto,
  type DeploymentOf,
  type DeploymentOutput,
  type DeploymentUpdate,
  type ManagedDeploymentInput,
} from "$lib/orpc/dtos/model.dto";
import type { ModelCompatibility } from "$lib/server/orpc/procedures/cluster.procedure";
import { handleVariant, type VariantHandlers } from "$lib/util";
import type { LicensedVram } from "../status-display";
import CapacitySection from "./CapacitySection.svelte";
import GeneralSection from "./GeneralSection.svelte";
import SettingsSection from "./SettingsSection.svelte";

type SectionType = "managed" | "canary";
export type SectionDraft = DeploymentOf<SectionType>;

type SharedField = keyof z.input<typeof DeploymentBaseInputDto>;
type CanaryMember = (typeof CANARY_MEMBERS)[number];

/** Every input field of a type, as a dotted path into the deployment. */
type FieldPath = {
  managed: SharedField | `managed.${keyof ManagedDeploymentInput}`;
  canary:
    | SharedField
    | `canary.${Exclude<keyof z.infer<typeof CanaryDeploymentPatchDto>, CanaryMember>}`
    | `canary.${CanaryMember}.${keyof CanaryMemberInput}`;
};

export type SectionContext = {
  creating: boolean;
  /** Fields that only a disabled deployment may change lock while this is true. */
  enabled: boolean;
  /** Null for a model the catalog does not describe. */
  models: Map<string, ModelWithSpecifier | null>;
  canEdit: boolean;
  takenPublicSpecifiers: string[];
  licensedVram: LicensedVram;
  nodeCapabilities: NodeCapability[];
  modelCompatibility: ModelCompatibility;
};

// `changed`: the draft differs from what is saved, as a new deployment always does.
// `blocked`: the section holds input that cannot be saved, or would be refused.
export type SectionProps = { draft: SectionDraft; context: SectionContext; editing: boolean; changed: boolean; blocked?: boolean };
export type SectionComponent = Component<SectionProps, object, "draft" | "blocked">;

type Section<T extends SectionType> = {
  title: string;
  component: SectionComponent;
  fields: readonly FieldPath[T][];
  shown?: (draft: SectionDraft, context: SectionContext) => boolean;
};

const GENERAL = { title: "General", component: GeneralSection } as const;
const CAPACITY = { title: "Capacity", component: CapacitySection } as const;
export type KvCacheMode = "settable" | "sized_by_engine" | "none";

/** Ollama sizes its cache itself, so only other engines take a KV cache size. */
const ENGINE_KV_CACHE: Record<Engine, KvCacheMode> = { vllm: "settable", ollama: "sized_by_engine" };

export const kvCacheMode = (model: ModelWithSpecifier): KvCacheMode => (keepsKvCache(model.type) ? ENGINE_KV_CACHE[model.engine] : "none");
export const kvCacheSettable = (model: ModelWithSpecifier) => kvCacheMode(model) === "settable";
export const hasSettings = (model: ModelWithSpecifier) => model.engine === "vllm" || model.type === "transcription";

const SETTINGS = {
  title: "Settings",
  component: SettingsSection,
  shown: (draft: SectionDraft, context: SectionContext) => partsOf(draft).members.some(({ member }) => {
    const model = context.models.get(member.specifier);
    return model ? hasSettings(model) : false;
  }),
} as const;

const SECTIONS = {
  managed: [
    { ...GENERAL, fields: ["name", "publicSpecifier"] },
    { ...CAPACITY, fields: ["managed.replicas", "managed.kvCacheSize"] },
    { ...SETTINGS, fields: ["managed.settings"] },
  ],
  canary: [
    { ...GENERAL, fields: ["name", "publicSpecifier"] },
    { ...CAPACITY, fields: ["canary.replicas", "canary.from.kvCacheSize", "canary.to.kvCacheSize"] },
    { ...SETTINGS, fields: ["canary.from.settings", "canary.to.settings"] },
  ],
} as const satisfies { [T in SectionType]: readonly Section<T>[] };

/** Fields the page edits outside the sections: the header's switch, and the model panel, which changes the model. */
const ELSEWHERE = {
  managed: ["enabled", "managed.specifier", "managed.preferredDriver"],
  canary: [
    "enabled", "canary.progress", "canary.advance",
    "canary.from.specifier", "canary.from.preferredDriver", "canary.to.specifier", "canary.to.preferredDriver",
  ],
} as const satisfies { [T in SectionType]: readonly FieldPath[T][] };

// Kept for API users, who may set them, but not shown in the dashboard.
const API_ONLY = ["description"] as const satisfies readonly SharedField[];

type Uncovered<T extends SectionType> = Exclude<
  FieldPath[T],
  (typeof SECTIONS)[T][number]["fields"][number] | (typeof ELSEWHERE)[T][number] | (typeof API_ONLY)[number]
>;
// A field no section owns fails here, naming the field.
const everyFieldHasAnOwner: { [T in SectionType]: [Uncovered<T>] extends [never] ? true : Uncovered<T> } = { managed: true, canary: true };
void everyFieldHasAnOwner;

type EditableSections = { deployment: SectionDraft; sections: readonly Section<SectionType>[] };

// A legacy deployment is migrated before it can be edited.
const SECTIONS_OF_TYPE: VariantHandlers<DeploymentOutput, EditableSections | null> = {
  legacy: () => null,
  managed: (deployment) => ({ deployment, sections: SECTIONS.managed }),
  canary: (deployment) => ({ deployment, sections: SECTIONS.canary }),
};

export function sectionsOf(deployment: DeploymentOutput, context: SectionContext): EditableSections | null {
  const editable = handleVariant(SECTIONS_OF_TYPE, deployment);
  if (!editable) {
    return null;
  }
  return { ...editable, sections: editable.sections.filter((section) => section.shown?.(editable.deployment, context) ?? true) };
}

type ModelMember = { label: string | null; member: CanaryMemberInput };

const PARTS: VariantHandlers<SectionDraft, { budget: { replicas: number }; minReplicas: number; members: ModelMember[] }> = {
  managed: (draft) => ({ budget: draft.managed, minReplicas: 1, members: [{ label: null, member: draft.managed }] }),
  canary: (draft) => ({
    budget: draft.canary,
    minReplicas: MIN_CANARY_REPLICAS,
    members: [{ label: "Moving away from", member: draft.canary.from }, { label: "Moving to", member: draft.canary.to }],
  }),
};

export const partsOf = (draft: SectionDraft) => handleVariant(PARTS, draft);

function valueAt(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], source);
}

const canonical = (value: unknown) =>
  JSON.stringify(value ?? null, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort()) : inner);

export function changedFields(draft: SectionDraft, base: SectionDraft, fields: readonly string[]): string[] {
  return fields.filter((field) => canonical(valueAt(draft, field)) !== canonical(valueAt(base, field)));
}

export function patchOf(draft: SectionDraft, fields: readonly string[]): DeploymentUpdate {
  const patch: Record<string, unknown> = { id: draft.id };
  for (const field of fields) {
    const keys = field.split(".");
    const last = keys.pop()!;
    let target = patch;
    for (const key of keys) {
      target = (target[key] ??= {}) as Record<string, unknown>;
    }
    target[last] = valueAt(draft, field);
  }
  // Built from paths the input type defines, which TypeScript cannot follow through the loop.
  return patch as DeploymentUpdate;
}
