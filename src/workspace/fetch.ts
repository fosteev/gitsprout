import { mapPool } from '../util/pool';
import { GitError, type RepoSummary } from '../git/types';

export interface FetchOutcome { root: string; name: string; ok: boolean; error?: string }

/**
 * Fetches every repo with bounded concurrency. Stops starting new fetches when `shouldStop()` turns true.
 * A fetch killed through an AbortSignal (`GitError` kind `Cancelled`) is not a failure: it counts as `skipped`.
 */
export async function fetchRepos(
  repos: readonly RepoSummary[],
  concurrency: number,
  fetchOne: (repo: RepoSummary, signal?: AbortSignal) => Promise<void>,
  opts: { signal?: AbortSignal; shouldStop?: () => boolean; onDone?: (outcome: FetchOutcome, done: number) => void } = {},
): Promise<{ outcomes: FetchOutcome[]; skipped: number }> {
  let done = 0;
  const res = await mapPool(repos, concurrency, async (r): Promise<FetchOutcome | undefined> => {
    let o: FetchOutcome;
    try { await fetchOne(r, opts.signal); o = { root: r.root, name: r.name, ok: true }; }
    catch (e) {
      if (e instanceof GitError && e.kind === 'Cancelled') return undefined;
      o = { root: r.root, name: r.name, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    opts.onDone?.(o, ++done);
    return o;
  }, opts.shouldStop);
  const outcomes = res.filter((o): o is FetchOutcome => o !== undefined);
  return { outcomes, skipped: res.length - outcomes.length };
}

export interface FetchSummary { text: string; incoming: string[]; failed: number; isError: boolean }

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Notification text after Fetch All (prototype `fetchAll()`): which repos have incoming commits.
 * `after` = summaries re-read after the fetch; only successfully fetched repos are counted.
 */
export function summarizeFetch(outcomes: readonly FetchOutcome[], after: readonly RepoSummary[], skipped = 0): FetchSummary {
  const okRoots = new Set(outcomes.filter((o) => o.ok).map((o) => o.root));
  const failures = outcomes.filter((o) => !o.ok);
  const inc = after.filter((r) => okRoots.has(r.root) && r.behind > 0);
  const parts: string[] = [`Fetched ${okRoots.size} ${plural(okRoots.size, 'repository', 'repositories')}.`];
  if (okRoots.size) {
    parts.push(inc.length
      ? `${inc.length} ${plural(inc.length, 'has', 'have')} incoming commits: ${inc.map((r) => `${r.name} ${r.behind}↓`).join(', ')}.`
      : 'Nothing incoming.');
  }
  if (failures.length) {
    parts.push(`${failures.length} failed: ${failures.map((f) => `${f.name} (${f.error ?? 'error'})`).join('; ')}.`);
  }
  if (skipped) parts.push(`Cancelled, ${skipped} not fetched.`);
  return { text: parts.join(' '), incoming: inc.map((r) => r.root), failed: failures.length, isError: failures.length > 0 && okRoots.size === 0 };
}
