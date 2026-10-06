import { basename } from 'node:path';
import type { SummaryStatus, Worktree } from '../git/types';
import { inside } from '../workspace/model';
import { repoDescription } from './repoModel';

/** `main` worktree label = the repo folder name, a linked one = its folder name. */
export const worktreeLabel = (w: Worktree): string => basename(w.path);

/** `<branch>* N↓ M↑ · main · locked · missing`; without a summary only the branch (or short sha) is known. */
export function worktreeDescription(w: Worktree, summary?: SummaryStatus): string {
  const s: SummaryStatus = summary ?? { branch: w.branch, sha: w.head, upstream: null, ahead: 0, behind: 0, changes: 0 };
  const tags = [w.main ? 'main' : '', w.locked !== null ? 'locked' : '', w.prunable !== null ? 'missing' : ''].filter(Boolean);
  return [w.bare ? 'bare' : repoDescription(s), ...tags].join(' · ');
}

export type WorktreeIcon = 'repo' | 'folder' | 'warning' | 'lock';

export function worktreeIcon(w: Worktree): WorktreeIcon {
  if (w.prunable !== null) return 'warning';
  if (w.locked !== null) return 'lock';
  return w.main ? 'repo' : 'folder';
}

/** Which worktree paths this window is on: a workspace folder that is the worktree, or the only worktree around it. */
export function currentWorktrees(worktrees: readonly Worktree[], folders: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const w of worktrees) {
    for (const f of folders) {
      if (f === w.path) { out.add(w.path); continue; }
      // A folder above the worktree counts only when no other worktree is in it too.
      if (inside(f, w.path) !== null && !worktrees.some((o) => o !== w && inside(f, o.path) !== null)) out.add(w.path);
      // A folder inside the worktree (a sub-directory opened as the workspace) counts unless another worktree is deeper.
      else if (inside(w.path, f) !== null && !worktrees.some((o) => o !== w && inside(w.path, o.path) !== null && inside(o.path, f) !== null)) out.add(w.path);
    }
  }
  return out;
}

/** `worktree.main` | `worktree.current` | `worktree.missing` | `worktree.locked` | `worktree`; the current one wins over the rest except main. */
export function worktreeContext(w: Worktree, current: boolean): string {
  if (w.main) return 'worktree.main';
  if (current) return 'worktree.current';
  if (w.prunable !== null) return 'worktree.missing';
  if (w.locked !== null) return 'worktree.locked';
  return 'worktree';
}
