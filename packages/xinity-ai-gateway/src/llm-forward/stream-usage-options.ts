/**
 * The `stream_options` the gateway sends on every streaming backend call. `include_usage` makes the
 * backend send a final usage chunk; `continuous_usage_stats` (vLLM) puts the cumulative usage on
 * every chunk, so a stream that ends early is still recorded with the tokens it used.
 */
export const STREAM_USAGE_OPTIONS = { include_usage: true, continuous_usage_stats: true } as const;
