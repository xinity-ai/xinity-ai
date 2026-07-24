/**
 * The one place that knows how each stack layer is edited: which keys are
 * hidden or marked for review, and where the result is stored. `stack init`,
 * `stack edit`, and the lazy editors inside `stack up` all go through these.
 */
import type { z } from "zod";
import { type Component, ENV_SCHEMAS } from "./component-meta.ts";
import { menuEditEnv, flattenBundle } from "./env-prompt.ts";
import {
  type StackDefinition, type FleetDefinition,
  STACK_SHARED_SCHEMA, STACK_SHARED_KEYS,
  applySharedResult, diffFromLayer,
  componentLayerBase, fleetLayerBase, getHost, saveStack,
} from "./stack.ts";

// Host-local defaults that are almost always wrong for a multi-host stack;
// marked in the editors so they get looked at instead of skipped.
const STACK_ATTENTION_KEYS: Partial<Record<Component, string[]>> = {
  gateway: ["HOST"],
  dashboard: ["ORIGIN", "GATEWAY_URL"],
};

export async function menuEditLayer(opts: {
  schema: z.ZodObject<any>;
  inherited: Record<string, string>;
  own: Record<string, string>;
  attentionKeys?: Set<string>;
  hiddenKeys?: Set<string>;
  message?: string;
}): Promise<Record<string, string> | null> {
  const result = await menuEditEnv(opts.schema, { ...opts.inherited, ...opts.own }, {
    attentionKeys: opts.attentionKeys,
    hiddenKeys: opts.hiddenKeys,
    inherited: opts.inherited,
    message: opts.message,
  });
  if (result === null) {
    return null;
  }
  return diffFromLayer(flattenBundle(result), opts.inherited);
}

/** Returns false when the user cancelled; nothing is stored then. */
export async function editSharedLayer(stack: StackDefinition, message = "Shared stack settings"): Promise<boolean> {
  const result = await menuEditEnv(STACK_SHARED_SCHEMA, { ...stack.env, ...stack.secrets }, {
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
  const overrides = await menuEditLayer({
    schema: ENV_SCHEMAS[component],
    inherited: componentLayerBase(stack, component),
    own: stack.componentEnv[component] ?? {},
    attentionKeys: new Set(STACK_ATTENTION_KEYS[component] ?? []),
    hiddenKeys: STACK_SHARED_KEYS,
    message,
  });
  if (overrides === null) {
    return false;
  }
  stack.componentEnv[component] = overrides;
  return true;
}

export async function editFleetLayer(
  stack: StackDefinition,
  fleet: FleetDefinition,
  message = `Daemon settings for fleet "${fleet.name}"`,
): Promise<boolean> {
  const overrides = await menuEditLayer({
    schema: ENV_SCHEMAS.daemon,
    inherited: fleetLayerBase(stack),
    own: fleet.envOverrides ?? {},
    hiddenKeys: STACK_SHARED_KEYS,
    message,
  });
  if (overrides === null) {
    return false;
  }
  fleet.envOverrides = overrides;
  return true;
}

export async function editHostLayer(
  stack: StackDefinition,
  address: string,
  component: Component,
  inherited: Record<string, string>,
): Promise<Record<string, string> | null> {
  const host = getHost(stack, address);
  const overrides = await menuEditLayer({
    schema: ENV_SCHEMAS[component],
    inherited,
    own: host?.envOverrides ?? {},
    hiddenKeys: STACK_SHARED_KEYS,
    message: `${component} settings for ${address} (saved as host overrides)`,
  });
  if (overrides === null) {
    return null;
  }
  if (host) {
    host.envOverrides = overrides;
    saveStack(stack);
  }
  return overrides;
}
