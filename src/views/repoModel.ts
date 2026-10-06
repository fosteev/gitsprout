import type { RepoSummary, SummaryStatus } from '../git/types';
import { repoDisplayName, subOf } from '../workspace/model';

/** Dirty working tree or out of sync with upstream. */
export function needsAttention(s: SummaryStatus): boolean {
  return s.changes > 0 || s.ahead > 0 || s.behind > 0;
}

/** `branch* N↓ M↑` (`*` = uncommitted changes); detached HEAD shows the short sha. */
export function repoDescription(s: SummaryStatus): string {
  const b = s.branch ?? (s.sha ? `(${s.sha.slice(0, 7)})` : 'HEAD');
  return `${b}${s.changes ? '*' : ''}${s.behind ? ` ${s.behind}↓` : ''}${s.ahead ? ` ${s.ahead}↑` : ''}`;
}

export function attentionCount(repos: readonly SummaryStatus[]): number {
  return repos.filter(needsAttention).length;
}

/** View description: `39 · 7 need attention`. */
export function viewDescription(repos: readonly SummaryStatus[], onlyAttention: boolean): string {
  return `${repos.length} · ${attentionCount(repos)} need attention${onlyAttention ? ' · filtered' : ''}`;
}

export type RepoTreeNode =
  | { kind: 'group' | 'sub'; key: string; label: string; description: string; children: RepoTreeNode[] }
  | { kind: 'repo'; key: string; repo: RepoSummary; /** linked worktrees nested under their main repo */ children: RepoTreeNode[] };

const byName = (a: RepoSummary, b: RepoSummary) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root);

function attDescription(total: number, att: number): string {
  return `${total} ${total === 1 ? 'repo' : 'repos'}${att ? ` · ${att} need attention` : ''}`;
}

/**
 * Group → sub-folders → repos (prototype `reposPane()`). Top-level repos (group '') come after the groups.
 * With `onlyAttention`, repos that don't need attention are hidden except the active one; empty groups disappear.
 * A linked worktree whose main repo is also in the list nests under it (wherever its own folder is); the main repo stays
 * when any of its worktrees needs attention.
 */
export function buildRepoTree(repos: readonly RepoSummary[], opts: { onlyAttention: boolean; activeRoot?: string }): RepoTreeNode[] {
  const visible = (r: RepoSummary) => !opts.onlyAttention || needsAttention(r) || r.root === opts.activeRoot;
  const present = new Set(repos.map((r) => r.root));
  const nested = (r: RepoSummary) => !!r.worktreeOf && r.worktreeOf !== r.root && present.has(r.worktreeOf);
  const kids = new Map<string, RepoSummary[]>();
  for (const r of repos) {
    if (!nested(r)) continue;
    const list = kids.get(r.worktreeOf!);
    if (list) list.push(r); else kids.set(r.worktreeOf!, [r]);
  }
  const shownKids = (r: RepoSummary) => (kids.get(r.root) ?? []).filter(visible).sort(byName);
  const visibleTop = (r: RepoSummary) => visible(r) || shownKids(r).length > 0;
  /** The repos a node list stands for, nested worktrees included (group counts). */
  const withKids = (list: readonly RepoSummary[]) => list.flatMap((r) => [r, ...(kids.get(r.root) ?? [])]);
  const groups = new Map<string, RepoSummary[]>();
  for (const r of repos.filter((x) => !nested(x))) {
    const list = groups.get(r.group);
    if (list) list.push(r); else groups.set(r.group, [r]);
  }
  const repoNode = (r: RepoSummary): RepoTreeNode => ({
    kind: 'repo', key: `repo:${r.root}`, repo: r,
    children: shownKids(r).map((k): RepoTreeNode => ({ kind: 'repo', key: `repo:${k.root}`, repo: k, children: [] })),
  });
  const out: RepoTreeNode[] = [];
  const names = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  for (const g of names) {
    const all = groups.get(g)!;
    const shown = all.filter(visibleTop).sort(byName);
    if (!shown.length) continue;
    const bySub = new Map<string, RepoSummary[]>();
    for (const r of shown) {
      const s = subOf(r.relPath);
      const list = bySub.get(s);
      if (list) list.push(r); else bySub.set(s, [r]);
    }
    const children: RepoTreeNode[] = (bySub.get('') ?? []).map(repoNode);
    for (const s of [...bySub.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))) {
      children.push({ kind: 'sub', key: `sub:${g}/${s}`, label: s, description: '', children: bySub.get(s)!.map(repoNode) });
    }
    out.push({ kind: 'group', key: `grp:${g}`, label: g, description: attDescription(withKids(all).length, attentionCount(withKids(all))), children });
  }
  out.push(...(groups.get('') ?? []).filter(visibleTop).sort(byName).map(repoNode));
  return out;
}

export type PickEntry =
  | { kind: 'separator'; label: string }
  | { kind: 'repo'; label: string; description: string; root: string; active: boolean };

export const ROOT_GROUP_LABEL = 'Workspace';

/** Quick pick for `switchRepository`, grouped by folder (prototype `qp-repo`). */
export function buildPickEntries(repos: readonly RepoSummary[], activeRoot?: string): PickEntry[] {
  const groups = new Map<string, RepoSummary[]>();
  for (const r of repos) {
    const list = groups.get(r.group);
    if (list) list.push(r); else groups.set(r.group, [r]);
  }
  const keys = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (groups.has('')) keys.push('');
  const out: PickEntry[] = [];
  for (const k of keys) {
    out.push({ kind: 'separator', label: k || ROOT_GROUP_LABEL });
    for (const r of groups.get(k)!.sort(byName)) {
      out.push({ kind: 'repo', label: r.name, description: `${repoDescription(r)} · ${r.relPath}`, root: r.root, active: r.root === activeRoot });
    }
  }
  return out;
}

export interface StatusBarModel { text: string; tooltip: string; command: string }

/** Status bar item: repo name → switch repo (several repos), "Gitsprout" → graph (one repo). Null = hide. */
export function statusBarModel(repos: readonly RepoSummary[], active: RepoSummary | undefined): StatusBarModel | null {
  if (repos.length === 0) return null;
  if (repos.length === 1) {
    return { text: '$(repo) Gitsprout', tooltip: `Gitsprout: Show Graph (${repoDisplayName(repos[0].name, repos[0].worktreeOf)})`, command: 'gitsprout.showGraph' };
  }
  const name = active ? repoDisplayName(active.name, active.worktreeOf) : 'Gitsprout';
  return { text: `$(repo) ${name}`, tooltip: 'Gitsprout: Switch Repository…', command: 'gitsprout.switchRepository' };
}

export function repoTooltip(r: RepoSummary): string {
  const lines = [r.root, repoDescription(r)];
  if (r.upstream) lines.push(`upstream: ${r.upstream}`);
  lines.push(r.changes ? `${r.changes} changed file${r.changes === 1 ? '' : 's'}` : 'working tree clean');
  return lines.join('\n');
}
