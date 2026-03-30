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
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const value = source();
    if (timer) clearTimeout(timer);
    if (value === resolvedImmediate) {
      current = resolvedImmediate;
    } else {
      timer = setTimeout(() => {
        current = value;
      }, delay);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  return {
    get current() {
      return current;
    },
  };
}
