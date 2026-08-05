/**
 * Minimal Prometheus text-format primitives shared by the services that expose
 * `/metrics`. Deliberately not a client library: no registry, no collectors, no
 * process metrics, just enough to serialize labeled counters, gauges, and
 * histograms in exposition format 0.0.4.
 */

export type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

type ScalarValues = Map<string, { labels: Labels; value: number }>;

function serializeScalar(
  name: string,
  help: string,
  type: string,
  values: ScalarValues,
): string {
  if (values.size === 0) return "";
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const { labels, value } of values.values()) {
    const lk = labelKey(labels);
    lines.push(lk ? `${name}{${lk}} ${value}` : `${name} ${value}`);
  }
  return lines.join("\n");
}

function addToLabelGroup(values: ScalarValues, labels: Labels, amount: number) {
  const key = labelKey(labels);
  const existing = values.get(key);
  if (existing) {
    existing.value += amount;
  } else {
    values.set(key, { labels, value: amount });
  }
}

export interface Metric {
  serialize(): string;
}

export function createCounter(name: string, help: string) {
  const values: ScalarValues = new Map();

  return {
    inc(labels: Labels, amount = 1) {
      addToLabelGroup(values, labels, amount);
    },
    serialize(): string {
      return serializeScalar(name, help, "counter", values);
    },
  };
}

export function createGauge(name: string, help: string) {
  const values: ScalarValues = new Map();

  return {
    inc(labels: Labels, amount = 1) {
      addToLabelGroup(values, labels, amount);
    },
    dec(labels: Labels, amount = 1) {
      addToLabelGroup(values, labels, -amount);
    },
    set(labels: Labels, value: number) {
      values.set(labelKey(labels), { labels, value });
    },
    serialize(): string {
      return serializeScalar(name, help, "gauge", values);
    },
  };
}

type HistogramEntry = { labels: Labels; sum: number; count: number; buckets: number[] };

export function createHistogram(name: string, help: string, boundaries: number[]) {
  const sorted = [...boundaries].sort((a, b) => a - b);
  const values = new Map<string, HistogramEntry>();

  return {
    observe(labels: Labels, value: number) {
      const key = labelKey(labels);
      let entry = values.get(key);
      if (!entry) {
        entry = { labels, sum: 0, count: 0, buckets: Array(sorted.length).fill(0) };
        values.set(key, entry);
      }
      entry.sum += value;
      entry.count += 1;
      for (let i = 0; i < sorted.length; i++) {
        if (value <= sorted[i]!) {
          entry.buckets[i]! += 1;
          break;
        }
      }
    },
    serialize(): string {
      if (values.size === 0) return "";
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
      for (const { labels, sum, count, buckets } of values.values()) {
        const lk = labelKey(labels);
        const prefix = lk ? `${lk},` : "";
        let cumulative = 0;
        for (let i = 0; i < sorted.length; i++) {
          cumulative += buckets[i]!;
          lines.push(`${name}_bucket{${prefix}le="${sorted[i]}"} ${cumulative}`);
        }
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${count}`);
        lines.push(`${name}_sum{${lk}} ${sum}`);
        lines.push(`${name}_count{${lk}} ${count}`);
      }
      return lines.join("\n");
    },
  };
}

/** Join a service's metrics into an exposition-format body, skipping ones with no observations. */
export function serializeMetrics(metrics: Metric[]): string {
  return metrics.map((m) => m.serialize()).filter(Boolean).join("\n\n") + "\n";
}
