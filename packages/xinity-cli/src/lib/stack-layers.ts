/**
 * The one place that knows how each stack layer is edited: which keys another
 * layer owns, and where the result is stored. `stack init`, `stack edit`, and
 * the lazy editors inside `stack up` all go through these.
 */

import { attentionKeysFor, checkComponentConfig, type Component } from "./component-meta.ts";
import { componentFields, menuEditEnv, flattenBundle } from "./env-prompt.ts";
import {
  type StackDefinition, type FleetDefinition,
  STACK_SHARED_KEYS, sharedFields,
  applySharedResult, diffFromLayer, sharedLayerProblems, isDeferredToDeploy, fillDeferred,
  componentLayerBase, fleetLayerBase, getHost, saveStack,
} from "./stack.ts";

export async function menuEditLayer(opts: {
  stack: StackDefinition;
  component: Component;
  inherited: Record<string, string>;
  own: Record<string, string>;
  hiddenKeys?: Set<string>;
  message?: string;
}): Promise<Record<string, string> | null> {
  const result = await menuEditEnv(componentFields(opts.component), { ...opts.inherited, ...opts.own }, {
    attentionKeys: attentionKeysFor(opts.component),
    hiddenKeys: opts.hiddenKeys,
    message: opts.message,
    // Judged against what deploy will supply, so only a stack with no host yet falls back to
    // forgiving the keys it cannot know.
    validate: (values) => checkComponentConfig(opts.component, fillDeferred(opts.stack, values))
      .filter((p) => !isDeferredToDeploy(p)),
  });
  if (result === null) {
    return null;
  }
  return diffFromLayer(flattenBundle(result), opts.inherited);
}

/** Returns false when the user cancelled; nothing is stored then. */
export async function editSharedLayer(stack: StackDefinition, message = "Shared stack settings"): Promise<boolean> {
  const result = await menuEditEnv(sharedFields(), { ...stack.env, ...stack.secrets }, {
    message,
    validate: (values) => sharedLayerProblems(stack, values),
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
    stack,
    component,
    inherited: componentLayerBase(stack, component),
    own: stack.componentEnv[component] ?? {},
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
    stack,
    component: "daemon",
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
    stack,
    component,
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
