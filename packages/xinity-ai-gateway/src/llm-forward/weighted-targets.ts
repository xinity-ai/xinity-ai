export type WeightedTarget<T> = { weight: number; target: T };

/**
 * The order to try targets in for one request: one drawn by weight, then the others as fallbacks,
 * heaviest first. A target of weight 0 is never drawn but still serves as a fallback.
 */
export function orderByWeight<T>(targets: WeightedTarget<T>[], random: () => number = Math.random): T[] {
  const byWeight = targets.toSorted((a, b) => b.weight - a.weight);
  const total = byWeight.reduce((sum, { weight }) => sum + Math.max(weight, 0), 0);
  let roll = random() * total;
  const drawn = byWeight.find(({ weight }) => (roll -= Math.max(weight, 0)) < 0) ?? byWeight[0];
  return drawn ? [drawn, ...byWeight.filter((candidate) => candidate !== drawn)].map(({ target }) => target) : [];
}
