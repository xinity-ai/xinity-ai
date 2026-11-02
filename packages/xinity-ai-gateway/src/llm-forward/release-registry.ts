/** Side channel for passing load-balancer release callbacks to withMetrics. */
export const releaseCallbacks = new WeakMap<Request, () => void>();

export function detachRelease(req: Request): () => void {
  const release = releaseCallbacks.get(req) ?? (() => {});
  releaseCallbacks.delete(req);
  return release;
}
