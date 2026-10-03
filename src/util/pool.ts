/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep the input order.
 * Once `shouldStop()` returns true no new item is started; skipped slots stay `undefined`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
