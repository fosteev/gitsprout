// Pure models of the Branches / Remotes / Stashes / Tags trees (no `vscode` import, unit-tested).
import type { FileStatus, LocalBranch, RemoteBranch, Stash, StashFile, Tag } from '../git/types';

export const short = (sha: string): string => sha.slice(0, 7);

/** `2↓ 1↑`, `gone` (upstream deleted), `local only` (no upstream), '' (in sync). */
export function branchDescription(b: Pick<LocalBranch, 'upstream' | 'upstreamGone' | 'ahead' | 'behind'>): string {
  if (b.upstreamGone) return 'gone';
  if (!b.upstream) return 'local only';
  return [b.behind ? `${b.behind}↓` : '', b.ahead ? `${b.ahead}↑` : ''].filter(Boolean).join(' ');
}

export type BranchContext = 'branch.local' | 'branch.local.head';
export const branchContext = (isHead: boolean): BranchContext => (isHead ? 'branch.local.head' : 'branch.local');

export interface BranchLeaf { kind: 'branch'; key: string; branch: LocalBranch; label: string; isHead: boolean }
export interface BranchFolder { kind: 'folder'; key: string; label: string; children: BranchLeaf[] }
export type BranchNode = BranchFolder | BranchLeaf;

const byName = (a: string, b: string) => a.localeCompare(b);

/**
 * Local branches grouped by the first `/` segment (`feature/x` → folder `feature`, leaf `x`); a leading or absent
 * `/` keeps the branch at the top level. Folders first (sorted), then top-level branches (sorted).
 */
export function buildBranchTree(locals: readonly LocalBranch[], headBranch: string | null): BranchNode[] {
  const groups = new Map<string, BranchLeaf[]>();
  const flat: BranchLeaf[] = [];
  for (const b of [...locals].sort((x, y) => byName(x.name, y.name))) {
    const i = b.name.indexOf('/');
    const leaf = (label: string): BranchLeaf => ({ kind: 'branch', key: `local:${b.name}`, branch: b, label, isHead: b.name === headBranch });
    if (i > 0 && i < b.name.length - 1) {
      const f = b.name.slice(0, i);
      const list = groups.get(f) ?? [];
      list.push(leaf(b.name.slice(i + 1)));
      groups.set(f, list);
    } else flat.push(leaf(b.name));
  }
  const folders = [...groups.keys()].sort(byName).map((f): BranchFolder => ({ kind: 'folder', key: `folder:${f}`, label: f, children: groups.get(f)! }));
  return [...folders, ...flat];
}

export interface RemoteLeaf { kind: 'remoteBranch'; key: string; ref: RemoteBranch; label: string }
export interface RemoteGroup { kind: 'remote'; key: string; name: string; children: RemoteLeaf[] }

/** Remote branches grouped by remote (text before the first `/`), numeric-aware sort like the prototype. */
export function buildRemoteTree(remotes: readonly RemoteBranch[]): RemoteGroup[] {
  const groups = new Map<string, RemoteLeaf[]>();
  for (const r of remotes) {
    const i = r.name.indexOf('/');
    if (i <= 0) continue;
    const remote = r.name.slice(0, i);
    const list = groups.get(remote) ?? [];
    list.push({ kind: 'remoteBranch', key: `remote:${r.name}`, ref: r, label: r.name.slice(i + 1) });
    groups.set(remote, list);
  }
  const num = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...groups.keys()].sort(byName).map((name) => ({
    kind: 'remote', key: `remotegroup:${name}`, name,
    children: groups.get(name)!.sort((a, b) => num(a.label, b.label)),
  }));
}

/** Newest-looking first: numeric-aware descending (`v1.10` before `v1.9`). */
export function sortTags(tags: readonly Tag[]): Tag[] {
  return [...tags].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
}

export const stashLabel = (s: Pick<Stash, 'index'>): string => `stash@{${s.index}}`;

export function fileDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
export function fileBase(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Row of a stash file: name, folder as description, status as icon (a letter badge would need a decoration provider). */
export function stashFileRow(f: Pick<StashFile, 'path' | 'origPath' | 'status' | 'untracked'>): { label: string; description: string; tooltip: string; icon: string; color: string } {
  const names: Record<FileStatus, [string, string, string]> = {
    M: ['diff-modified', 'gitDecoration.modifiedResourceForeground', 'Modified'],
    A: ['diff-added', 'gitDecoration.addedResourceForeground', 'Added'],
    D: ['diff-removed', 'gitDecoration.deletedResourceForeground', 'Deleted'],
    R: ['diff-renamed', 'gitDecoration.renamedResourceForeground', 'Renamed'],
    U: ['warning', 'gitDecoration.conflictingResourceForeground', 'Conflicted'],
  };
  const [icon, color, word] = names[f.status];
  const what = f.untracked ? 'Untracked' : word;
  return {
    label: fileBase(f.path), description: fileDir(f.path), icon, color,
    tooltip: f.origPath ? `${what}: ${f.origPath} → ${f.path}` : `${what}: ${f.path}`,
  };
}

/** `TreeView.description`: the repo name in multi-repo mode, nothing for a single repo. */
export function repoViewDescription(repoName: string | undefined, multiRepo: boolean): string | undefined {
  return multiRepo && repoName ? repoName : undefined;
}
