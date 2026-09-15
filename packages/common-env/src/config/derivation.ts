import { sameConfigValue } from "./resolve";

export type Derived<R> = {
  get: () => R;
  subscribe: (listener: (value: R) => void) => () => void;
};

export type Derivation = { revalidate: () => void };

type Built<I, R> = { inputs: I; value: R };

export function createDerivation<T, I, R>(deps: {
  values: T;
  selectInputs: (values: T) => I;
  build: (inputs: I) => R;
  dispose?: (value: R) => void;
}): Derived<R> & Derivation {
  const listeners = new Set<(value: R) => void>();
  let built: Built<I, R> | null = null;

  const currentInputs = () => deps.selectInputs(deps.values);

  function disposeIgnoringFailure(value: R): void {
    try {
      deps.dispose?.(value);
    } catch {}
  }

  function ensureBuilt(): Built<I, R> {
    const inputs = currentInputs();
    return built ??= { inputs, value: deps.build(inputs) };
  }

  function takeIfInputsMoved(inputs: I): Built<I, R> | null {
    if (!built || sameConfigValue(built.inputs, inputs)) {
      return null;
    }
    const stale = built;
    built = null;
    return stale;
  }

  function rebuildAndNotify(stale: Built<I, R>, inputs: I): void {
    let next: Built<I, R>;
    try {
      next = { inputs, value: deps.build(inputs) };
    } catch {
      return;
    }

    built = next;
    if (Object.is(stale.value, next.value)) {
      return;
    }

    disposeIgnoringFailure(stale.value);
    for (const listener of listeners) {
      listener(next.value);
    }
  }

  return {
    get: () => ensureBuilt().value,

    subscribe(listener) {
      listeners.add(listener);
      listener(ensureBuilt().value);
      return () => listeners.delete(listener);
    },

    revalidate() {
      const inputs = currentInputs();
      const stale = takeIfInputsMoved(inputs);
      if (!stale) {
        return;
      }

      if (listeners.size === 0) {
        disposeIgnoringFailure(stale.value);
        return;
      }
      rebuildAndNotify(stale, inputs);
    },
  };
}
