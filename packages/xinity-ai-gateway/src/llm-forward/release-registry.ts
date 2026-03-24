/** Side channel for passing load-balancer release callbacks to withMetrics. */
export const releaseCallbacks = new WeakMap<Request, () => void>();
