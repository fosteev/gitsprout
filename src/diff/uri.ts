// Pure helpers for `gitsprout:` URIs and diff plans (no `vscode` import, unit-tested).
import type { FileChange, FileStat, StashFile } from '../git/types';

export const SCHEME = 'gitsprout';

/** What a `gitsprout:` document shows: `<ref>:<path>` of the repo at `root`; ref `""` = an empty side. */
export interface DiffTarget { root: string; ref: string; path: string }

export function encodeQuery(t: DiffTarget): string {
  return encodeURIComponent(JSON.stringify({ root: t.root, ref: t.ref, path: t.path }));
}

/** Inverse of `encodeQuery`; `undefined` for anything that is not a well-formed target. */
export function decodeQuery(query: string): DiffTarget | undefined {
  try {
    const o = JSON.parse(decodeURIComponent(query)) as Partial<DiffTarget> | null;
    if (!o || typeof o.root !== 'string' || typeof o.ref !== 'string' || typeof o.path !== 'string') return undefined;
    return { root: o.root, ref: o.ref, path: o.path };
  } catch { return undefined; }
}

/** Components of the URI for a target: the path keeps the file name (language detection, tab label). */
export function uriParts(t: DiffTarget): { scheme: string; path: string; query: string } {
  return { scheme: SCHEME, path: '/' + t.path, query: encodeQuery(t) };
}

/**
 * Whether a document for this ref can change while it stays open: anything but a full commit id (optionally with a
 * `^n` parent suffix) — `:` (index), `HEAD`, branch or `stash@{i}` names move. `''` (empty side) never changes.
 */
export function isVolatileRef(ref: string): boolean {
  return ref !== '' && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?(?:\^\d*)?$/.test(ref);
}

export type Side =
  | { kind: 'git'; ref: string; path: string }   // ref '' = empty document (path keeps the tab/language)
  | { kind: 'file'; path: string };              // working-tree file, relative to the repo root

export type DiffPlan =
  | { kind: 'diff'; left: Side; right: Side; title: string }
  | { kind: 'open'; path: string };              // untracked: a normal editor

const git = (ref: string, path: string): Side => ({ kind: 'git', ref, path });
const emptyAt = (path: string): Side => ({ kind: 'git', ref: '', path });

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
export const short = (sha: string): string => sha.slice(0, 7);

export function diffTitle(path: string, label: string): string {
  return `${baseName(path)} (${label})`;
}

/** Commit file: parent vs commit. `parent` (first parent sha) is only used for the title; root commits show `empty`. */
export function commitFilePlan(sha: string, file: Pick<FileStat, 'path' | 'origPath' | 'status'>, parent?: string): DiffPlan {
  const hasParent = parent !== undefined && parent !== '';
  const left = file.status === 'A' || !hasParent ? emptyAt(file.origPath ?? file.path) : git(`${sha}^`, file.origPath ?? file.path);
  const right = file.status === 'D' ? emptyAt(file.path) : git(sha, file.path);
  return { kind: 'diff', left, right, title: diffTitle(file.path, `${hasParent ? short(parent) : 'empty'} ↔ ${short(sha)}`) };
}

/** Working-tree change: index vs file. Untracked files open normally; a file deleted on disk shows an empty right side. */
export function unstagedPlan(file: Pick<FileChange, 'path' | 'status' | 'untracked'>): DiffPlan {
  if (file.untracked) return { kind: 'open', path: file.path };
  const right: Side = file.status === 'D' ? emptyAt(file.path) : { kind: 'file', path: file.path };
  return { kind: 'diff', left: git(':', file.path), right, title: diffTitle(file.path, 'Working Tree') };
}

/** Staged change: HEAD vs index. `unborn` = no commit yet. */
export function stagedPlan(file: Pick<FileChange, 'path' | 'origPath' | 'status'>, unborn: boolean): DiffPlan {
  const p = file.origPath ?? file.path;
  const left = unborn || file.status === 'A' ? emptyAt(p) : git('HEAD', p);
  const right = file.status === 'D' ? emptyAt(file.path) : git(':', file.path);
  return { kind: 'diff', left, right, title: diffTitle(file.path, 'Index') };
}

/**
 * Stash file: the stash's base vs the stash commit (untracked files live in `<stash>^3`). The refs use the stash
 * commit sha, not `stash@{i}`: indexes shift when a stash is pushed or dropped, and an open document keyed by a
 * `stash@{i}` URI would then show another stash. The title keeps `stash@{i}`.
 */
export function stashFilePlan(stash: { index: number; sha: string }, file: Pick<StashFile, 'path' | 'origPath' | 'status' | 'untracked'>): DiffPlan {
  const ref = stash.sha;
  const left = file.untracked || file.status === 'A' ? emptyAt(file.origPath ?? file.path) : git(`${ref}^1`, file.origPath ?? file.path);
  const right = file.status === 'D' ? emptyAt(file.path) : git(file.untracked ? `${ref}^3` : ref, file.path);
  return { kind: 'diff', left, right, title: diffTitle(file.path, `stash@{${stash.index}}`) };
}
