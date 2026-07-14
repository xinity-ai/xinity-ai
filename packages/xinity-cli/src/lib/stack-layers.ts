/**
 * The one place that knows how each stack layer is edited: what its base
 * (the layers below) is, which keys are hidden or marked for review, and
 * where the result is stored. `stack init`, `stack edit`, and the lazy
 * editors inside `stack up` all go through these.
 */
import { type Component, ENV_SCHEMAS, getAutoDefaults } from "./component-meta.ts";
import { menuEditEnv, flattenBundle } from "./env-prompt.ts";
import {
  type StackDefinition, type FleetDefinition,
  STACK_SHARED_SCHEMA, STACK_SHARED_KEYS,
  applySharedResult, sharedHiddenKeys, diffFromLayer,
} from "./stack.ts";

// Host-local defaults that are almost always wrong for a multi-host stack;
// marked in the editors so they get looked at instead of skipped.
const STACK_ATTENTION_KEYS: Partial<Record<Component, string[]>> = {
  gateway: ["HOST"],
  dashboard: ["ORIGIN", "GATEWAY_URL"],
};

export function componentLayerBase(stack: StackDefinition, component: Component): Record<string, string> {
  return { ...getAutoDefaults(component), ...stack.env, ...stack.secrets };
}

export function componentLayerSeed(stack: StackDefinition, component: Component): Record<string, string> {
  return { ...componentLayerBase(stack, component), ...(stack.componentEnv[component] ?? {}) };
}

export function fleetLayerBase(stack: StackDefinition): Record<string, string> {
  return componentLayerSeed(stack, "daemon");
}

export function fleetLayerSeed(stack: StackDefinition, fleet: FleetDefinition): Record<string, string> {
  return { ...fleetLayerBase(stack), ...(fleet.envOverrides ?? {}) };
}

/** Returns false when the user cancelled; nothing is stored then. */
export async function editSharedLayer(stack: StackDefinition, message = "Shared stack settings"): Promise<boolean> {
  const result = await menuEditEnv(STACK_SHARED_SCHEMA, { ...stack.env, ...stack.secrets }, {
    hiddenKeys: sharedHiddenKeys(stack),
    message,
  });
  if (result === null) {
    return false;
  }
  applySharedResult(stack, result);
  return true;
}

export async function editComponentLayer(
  stack: StackDefinition,
  component: Component,
  message = `${component} settings (stack-wide)`,
): Promise<boolean> {
  const base = componentLayerBase(stack, component);
  const result = await menuEditEnv(ENV_SCHEMAS[component], componentLayerSeed(stack, component), {
    attentionKeys: new Set(STACK_ATTENTION_KEYS[component] ?? []),
    hiddenKeys: STACK_SHARED_KEYS,
    message,
  });
  if (result === null) {
    return false;
  }
  stack.componentEnv[component] = diffFromLayer(flattenBundle(result), base);
  return true;
}

export async function editFleetLayer(
  stack: StackDefinition,
  fleet: FleetDefinition,
  message = `Daemon settings for fleet "${fleet.name}"`,
): Promise<boolean> {
  const base = fleetLayerBase(stack);
  const result = await menuEditEnv(ENV_SCHEMAS.daemon, fleetLayerSeed(stack, fleet), {
    hiddenKeys: STACK_SHARED_KEYS,
    message,
  });
  if (result === null) {
    return false;
  }
  fleet.envOverrides = diffFromLayer(flattenBundle(result), base);
  return true;
}
