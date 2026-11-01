import type { OrgModel } from "$lib/server/lib/models/org-models";

const placeholder: OrgModel = {
  publicSpecifier: "your-deployment",
  name: "Your Deployment",
  type: "chat",
  tools: true,
  vision: false,
  ready: false,
  contextWindow: 131072,
};

export type ModelSelection = ReturnType<typeof createModelSelection>;

export function createModelSelection(getModels: () => OrgModel[]) {
  let picked = $state<string[] | null>(null);
  let primary = $state("");

  const models = $derived(getModels());
  const preferred = $derived(models.find(m => m.ready) ?? models[0]);
  const selected = $derived(picked ?? (preferred ? [preferred.publicSpecifier] : []));
  const chosen = $derived(models.filter(m => selected.includes(m.publicSpecifier)));
  const entries = $derived(chosen.length > 0 ? chosen : [placeholder]);
  const effectivePrimary = $derived(selected.includes(primary) ? primary : selected[0] ?? placeholder.publicSpecifier);

  return {
    get models() {
      return models;
    },
    get selected() {
      return selected;
    },
    get entries() {
      return entries;
    },
    get primary() {
      return effectivePrimary;
    },
    set primary(publicSpecifier: string) {
      primary = publicSpecifier;
    },
    toggle(publicSpecifier: string) {
      picked = selected.includes(publicSpecifier)
        ? selected.filter(s => s !== publicSpecifier)
        : [...selected, publicSpecifier];
    },
  };
}
