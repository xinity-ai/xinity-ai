export type DeploymentStrategy = "first-fit" | "balanced" | "bin-pack" | "proportional";

export type Capacity = { total: number; used: number };

export function orderByStrategy<T>(strategy: DeploymentStrategy, items: T[], capacityOf: (item: T) => Capacity | undefined): T[] {
  const free = (item: T) => {
    const cap = capacityOf(item);
    return cap ? cap.total - cap.used : 0;
  };
  const ratio = (item: T) => {
    const cap = capacityOf(item);
    return cap && cap.total > 0 ? cap.used / cap.total : 1;
  };
  const ordered = [...items];
  switch (strategy) {
    case "first-fit":    return ordered;
    case "balanced":     return ordered.sort((a, b) => free(b) - free(a));
    case "bin-pack":     return ordered.sort((a, b) => free(a) - free(b));
    case "proportional": return ordered.sort((a, b) => ratio(a) - ratio(b));
  }
}
