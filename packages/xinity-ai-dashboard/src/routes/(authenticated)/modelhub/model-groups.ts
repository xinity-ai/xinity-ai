import type { ModelWithSpecifier } from "xinity-infoserver";

export type ModelGroup = {
  leader: ModelWithSpecifier;
  /** Leader first, then the order the catalog delivered them in. */
  variants: ModelWithSpecifier[];
};

function resolveLeader(
  model: ModelWithSpecifier,
  bySpecifier: Map<string, ModelWithSpecifier>,
): ModelWithSpecifier {
  if (!model.variantOf || model.variantOf === model.publicSpecifier) {
    return model;
  }
  const leader = bySpecifier.get(model.variantOf);
  // A variant may not itself have variants, and an unloaded or filtered-out leader
  // leaves this entry standing on its own.
  return leader && !leader.variantOf ? leader : model;
}

export function groupModelVariants(models: ModelWithSpecifier[]): ModelGroup[] {
  const bySpecifier = new Map(models.map(model => [model.publicSpecifier, model]));
  const groups = new Map<string, ModelGroup>();

  for (const model of models) {
    const leader = resolveLeader(model, bySpecifier);
    const group = groups.get(leader.publicSpecifier);
    if (group) {
      group.variants.push(model);
    } else {
      groups.set(leader.publicSpecifier, { leader, variants: [model] });
    }
  }

  for (const group of groups.values()) {
    group.variants.sort((a, b) => Number(b === group.leader) - Number(a === group.leader));
  }

  return [...groups.values()];
}
