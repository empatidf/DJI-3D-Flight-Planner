/**
 * Concurrency limiter. Cesium fires requestImage/requestTileGeometry for
 * every visible tile at once (no throttling for custom providers); without
 * a cap, a zoom-out queues hundreds of decodes + canvases simultaneously.
 */
export function createLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<{
    fn: () => unknown;
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  const next = () => {
    if (active >= maxConcurrent || waiting.length === 0) return;
    active++;
    const { fn, resolve, reject } = waiting.shift()!;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return <T>(fn: () => T | Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      next();
    });
}
