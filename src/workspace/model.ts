import { basename, relative, sep } from 'node:path';
import type { RepoSummary, SummaryStatus } from '../git/types';

export interface FolderRef { name: string; path: string }

function inside(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + sep) || /^[a-zA-Z]:/.test(rel) || rel.startsWith(sep)) return null;
  return rel.split(sep).join('/');
}

/**
 * Where a repo sits in the workspace. With several workspace folders `relPath` is prefixed by the folder name
 * (so `group` = folder); with one folder it is relative to it. `depth` is the segment count below the folder
 * (what the built-in `git.repositoryScanMaxDepth` counts).
 */
export function locate(root: string, folders: readonly FolderRef[]): { relPath: string; group: string; depth: number } {
  let best: { folder: FolderRef; rel: string } | null = null;
  for (const f of folders) {
    const rel = inside(f.path, root);
    if (rel === null) continue;
    if (!best || f.path.length > best.folder.path.length) best = { folder: f, rel };
  }
  let relPath: string;
  let depth: number;
  if (!best) { relPath = basename(root); depth = 0; }
  else {
    depth = best.rel === '' ? 0 : best.rel.split('/').length;
    const prefix = folders.length > 1 ? best.folder.name : '';
    relPath = [prefix, best.rel].filter(Boolean).join('/') || basename(root);
  }
  const segs = relPath.split('/');
  return { relPath, group: segs.length > 1 ? segs[0] : '', depth };
}

/** Middle segments of `relPath` (between group and name), '' when there are none. */
export function subOf(relPath: string): string {
  return relPath.split('/').slice(1, -1).join('/');
}

export function makeRepoSummary(root: string, folders: readonly FolderRef[], status: SummaryStatus): RepoSummary {
  const { relPath, group } = locate(root, folders);
  return { ...status, root, name: basename(root), relPath, group };
}

export function sameSummary(a: SummaryStatus, b: SummaryStatus): boolean {
  return a.branch === b.branch && a.sha === b.sha && a.upstream === b.upstream
    && a.ahead === b.ahead && a.behind === b.behind && a.changes === b.changes;
}

/** The repo that contains `fsPath` (longest root prefix on a path boundary), or undefined. */
export function repoForPath(roots: readonly string[], fsPath: string): string | undefined {
  let best: string | undefined;
  for (const r of roots) {
    if (inside(r, fsPath) === null) continue;
    if (best === undefined || r.length > best.length) best = r;
  }
  return best;
}

/** Built-in SCM sees repos up to `maxDepth` levels below a folder. Null = nothing to say. */
export function scmDepthCheck(depths: readonly number[], maxDepth: number): { visible: number; total: number; needed: number } | null {
  if (maxDepth < 0 || depths.length === 0) return null;
  const visible = depths.filter((d) => d <= maxDepth).length;
  if (visible === depths.length) return null;
  return { visible, total: depths.length, needed: Math.max(...depths) };
}
