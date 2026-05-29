/**
 * Reactive debounced value using Svelte 5 runes.
 *
 * Returns a reactive object whose `.current` trails the source getter
 * by the specified delay. Clearing to the `immediate` value (default: the
 * initial value) bypasses the delay so the UI feels snappy on reset.
 */
export function useDebouncedValue<T>(
  source: () => T,
  delay: number,
  { immediate }: { immediate?: T } = {},
) {
  const resolvedImmediate = immediate ?? source();
  let current = $state(resolvedImmediate);

  $effect(() => {
    const value = source();
    if (value === resolvedImmediate) {
      current = resolvedImmediate;
      return;
    }
    const handle = setTimeout(() => {
      current = value;
    }, delay);
    return () => clearTimeout(handle);
  });

  return {
    get current() {
      return current;
    },
  };
}
