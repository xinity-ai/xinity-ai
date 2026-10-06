/** paths whose backend generation can outrun bun's 255s connection cap, and are bounded by BACKEND_TIMEOUT_MS instead */
export const LONG_RUNNING_ROUTES = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/audio/transcriptions",
  "/v1/responses",
]);
