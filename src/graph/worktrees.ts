// Pure part of the graph's worktree data: which worktree is this tab's own, and the `GraphWorktree` list for `state`.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Worktree } from '../git/types';
import type { GraphWorktree } from './protocol';

/** At most this many `status` reads per load for worktrees the registry does not know. */
export const MAX_WORKTREE_SUMMARIES = 10;

/** Same folder, also through symlinks (`/var` vs `/private/var`); an unreadable path only equals itself. */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** Prunable (missing) and bare entries have no working tree to show. */
export const showable = (w: Worktree): boolean => w.prunable === null && !w.bare;

/**
 * `list` as the webview gets it. `root` is the worktree this tab is bound to. `changes` holds the uncommitted-file counts
 * that are known (missing key = unknown = 0).
 */
export function graphWorktrees(list: readonly Worktree[], root: string, changes: ReadonlyMap<string, number>, same: (a: string, b: string) => boolean = samePath): GraphWorktree[] {
  return list.filter(showable).map((w) => ({
    path: w.path,
    name: basename(w.path),
    branch: w.branch,
    head: w.head,
    changes: changes.get(w.path) ?? 0,
    current: same(w.path, root),
    main: w.main,
  }));
}

/** The worktrees whose uncommitted-file count has to be read: not this tab's own, not known yet, at most `max`. */
export function needSummary(list: readonly GraphWorktree[], known: (path: string) => boolean, max = MAX_WORKTREE_SUMMARIES): string[] {
  return list.filter((w) => !w.current && !known(w.path)).slice(0, max).map((w) => w.path);
}
