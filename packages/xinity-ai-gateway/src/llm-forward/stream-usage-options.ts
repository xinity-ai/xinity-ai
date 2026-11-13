/**
 * The `stream_options` the gateway sends on every streaming backend call. `include_usage` makes the
 * backend send a final usage chunk; `continuous_usage_stats` (vLLM) puts the cumulative usage on
 * every chunk, so a stream that ends early is still recorded with the tokens it used.
 */
export const STREAM_USAGE_OPTIONS = { include_usage: true, continuous_usage_stats: true } as const;

/**
 * The AI SDK provider's `transformRequestBody` hook. It adds `STREAM_USAGE_OPTIONS` to a streaming
 * body and keeps its other `stream_options`. It returns a non-streaming body without change.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the type of the provider hook
export function addStreamUsageOptions(args: Record<string, any>): Record<string, any> {
  if (args.stream !== true) {
    return args;
  }
  return { ...args, stream_options: { ...args.stream_options, ...STREAM_USAGE_OPTIONS } };
}
