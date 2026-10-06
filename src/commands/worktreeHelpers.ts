// Pure helpers behind the worktree commands (no `vscode` import, unit-tested): folder naming, input validation,
// quick pick contents, notification texts.
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Refs, Worktree } from '../git/types';
import { localNameOf, shortSha } from './messages';

/** Branch -> folder name: every run of characters outside `[A-Za-z0-9._-]` becomes `-`. */
export const worktreeSlug = (branch: string): string => branch.replace(/[^A-Za-z0-9._-]+/g, '-');

/** Folder name for a worktree: the branch slug, `detached-<sha7>` without a branch. */
export const worktreeFolderName = (branch: string | null, sha: string): string =>
  branch ? worktreeSlug(branch) : `detached-${shortSha(sha)}`;

/** A leading `~` is the home directory. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/**
 * Where a new worktree goes by default: `<setting>/<repoName>/<slug>` when `gitsprout.worktreeFolder` is set,
 * else `<dirname(mainRoot)>/<basename(mainRoot)>.worktrees/<slug>`.
 */
export function defaultWorktreePath(mainRoot: string, slug: string, setting: string, home: string): string {
  const base = setting.trim();
  if (base) return join(expandHome(base, home), basename(mainRoot), slug);
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`, slug);
}

/** What is on disk at the path the user typed. */
export interface PathProbe { exists: boolean; isDir: boolean; empty: boolean }

/** Validation message for the path input box ('' = ok): absolute, not used by a worktree, free or an empty directory. */
export function worktreePathError(path: string, probe: PathProbe, used: readonly string[]): string {
  if (!path.trim()) return 'Please provide a folder for the worktree';
  if (!isAbsolute(path)) return 'Please provide an absolute path';
  if (used.includes(path)) return 'A worktree already uses this folder';
  if (probe.exists && !(probe.isDir && probe.empty)) return 'The folder already exists and is not empty';
  return '';
}

export type CreateEntry =
  | { kind: 'separator'; label: string }
  | { kind: 'new'; label: string; description: string }
  | { kind: 'detached'; label: string; description: string }
  | { kind: 'branch'; label: string; description: string }
  | { kind: 'busy'; label: string; description: string; worktree: string }
  | { kind: 'remote'; label: string; description: string; local: string };

/**
 * Step 1 of Create Worktree. From a commit only `New branch…` and `Detached HEAD` are offered; otherwise
 * `New branch…`, free local branches, branches checked out somewhere (`in <name>`) and remote branches without
 * a local namesake. `worktrees` names the worktree a busy branch is in.
 */
export function buildCreateEntries(
  refs: Refs, worktrees: readonly Worktree[], opts: { fromSha?: string } = {},
): CreateEntry[] {
  if (opts.fromSha) {
    return [
      { kind: 'new', label: 'New branch…', description: `from ${shortSha(opts.fromSha)}` },
      { kind: 'detached', label: 'Detached HEAD', description: 'no branch, for a quick look' },
    ];
  }
  const out: CreateEntry[] = [{ kind: 'new', label: 'New branch…', description: `from ${refs.head.branch ?? 'HEAD'}` }];
  const free = refs.locals.filter((b) => b.worktree === null);
  const busy = refs.locals.filter((b) => b.worktree !== null);
  if (free.length || busy.length) {
    out.push({ kind: 'separator', label: 'local branches' });
    for (const b of free) out.push({ kind: 'branch', label: b.name, description: '' });
    for (const b of busy) {
      const w = worktrees.find((x) => x.path === b.worktree);
      out.push({ kind: 'busy', label: b.name, description: `in ${basename(w?.path ?? b.worktree!)}`, worktree: b.worktree! });
    }
  }
  const locals = new Set(refs.locals.map((b) => b.name));
  const remotes = refs.remotes.filter((r) => !r.name.endsWith('/HEAD') && !locals.has(localNameOf(r.name)));
  if (remotes.length) {
    out.push({ kind: 'separator', label: 'remote branches' });
    for (const r of remotes) out.push({ kind: 'remote', label: r.name, description: 'creates a tracking branch', local: localNameOf(r.name) });
  }
  return out;
}

export const createdMessage = (name: string, path: string): string => `Worktree ${name} created at ${path}`;
export const checkedOutInMessage = (branch: string, name: string): string => `Branch ${branch} is checked out in worktree ${name}.`;
export const lockedMessage = (name: string, reason: string): string => `Worktree ${name} is locked${reason ? `: ${reason}` : ''}.`;
export const removeTitle = (name: string): string => `Remove worktree “${name}”?`;

/** Modal body of the remove dialog. */
export function removeDetail(path: string, changes: number): string {
  return `The folder ${path} will be deleted.${changes ? `\n\nIt has ${changes} uncommitted change${changes === 1 ? '' : 's'}; they will be lost.` : ''}`;
}

export function pruneDetail(paths: readonly string[]): string {
  return `git worktree prune drops the records of:\n${paths.map((p) => `• ${p}`).join('\n')}\nBranches and commits are not touched.`;
}

/** A tree node, a Branches leaf (`branch.worktree` = where it is checked out), a graph context (`{ path }`) or a bare path. */
export function worktreePathFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg || undefined;
  const a = arg as { worktree?: { path?: unknown }; branch?: { worktree?: unknown }; path?: unknown } | null;
  const p = a?.worktree?.path ?? a?.branch?.worktree ?? a?.path;
  return typeof p === 'string' && p ? p : undefined;
}
