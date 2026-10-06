import { describe, expect, it } from 'vitest';
import type { Refs, Worktree } from '../src/git/types';
import {
  buildCreateEntries, defaultWorktreePath, expandHome, pruneDetail, removeDetail, worktreeFolderName, worktreePathError, worktreeSlug, worktreePathFromArg,
} from '../src/commands/worktreeHelpers';
import { currentWorktrees, worktreeContext, worktreeDescription, worktreeIcon, worktreeLabel } from '../src/views/worktreeModel';

const wt = (path: string, over: Partial<Worktree> = {}): Worktree =>
  ({ path, head: 'abcdef1234567', branch: 'main', bare: false, main: false, locked: null, prunable: null, ...over });

describe('worktree view model', () => {
  const main = wt('/p/app', { main: true });
  const linked = wt('/p/app.worktrees/feat', { branch: 'feat' });

  it('label is the folder name', () => {
    expect(worktreeLabel(main)).toBe('app');
    expect(worktreeLabel(linked)).toBe('feat');
  });

  it('description: branch and tags, status when a summary is known', () => {
    expect(worktreeDescription(main)).toBe('main · main');
    expect(worktreeDescription(wt('/x', { branch: null, locked: '' }))).toBe('(abcdef1) · locked');
    expect(worktreeDescription(wt('/x', { prunable: 'missing' }))).toBe('main · missing');
    const s = { branch: 'feat', sha: 'a', upstream: 'origin/feat', ahead: 1, behind: 2, changes: 3 };
    expect(worktreeDescription(linked, s)).toBe('feat* 2↓ 1↑');
    expect(worktreeDescription(wt('/x', { bare: true, branch: null, head: null }))).toBe('bare');
  });

  it('icon: missing > locked > main > folder', () => {
    expect(worktreeIcon(main)).toBe('repo');
    expect(worktreeIcon(linked)).toBe('folder');
    expect(worktreeIcon(wt('/x', { locked: 'r' }))).toBe('lock');
    expect(worktreeIcon(wt('/x', { locked: '', prunable: 'missing' }))).toBe('warning');
  });

  it('contextValue: main first, then current, missing, locked', () => {
    expect(worktreeContext(main, true)).toBe('worktree.main');
    expect(worktreeContext(linked, true)).toBe('worktree.current');
    expect(worktreeContext(wt('/x', { prunable: 'missing' }), false)).toBe('worktree.missing');
    expect(worktreeContext(wt('/x', { locked: '' }), false)).toBe('worktree.locked');
    expect(worktreeContext(linked, false)).toBe('worktree');
  });

  it('current: the folder is the worktree, or the only worktree inside it', () => {
    const list = [main, linked];
    expect([...currentWorktrees(list, ['/p/app'])]).toEqual(['/p/app']);
    expect([...currentWorktrees(list, ['/p/app.worktrees/feat'])]).toEqual(['/p/app.worktrees/feat']);
    expect([...currentWorktrees(list, ['/p/app.worktrees'])]).toEqual(['/p/app.worktrees/feat']);
    // a folder above both worktrees is no particular one
    expect([...currentWorktrees(list, ['/p'])]).toEqual([]);
    // a sub-folder opened as the workspace belongs to its worktree
    expect([...currentWorktrees(list, ['/p/app/src'])]).toEqual(['/p/app']);
    expect([...currentWorktrees(list, [])]).toEqual([]);
  });

  it('current: a worktree nested in the main one does not make the main one "inside"', () => {
    const nested = wt('/p/app/.wt/x');
    expect([...currentWorktrees([main, nested], ['/p/app'])]).toEqual(['/p/app']);
    expect([...currentWorktrees([main, nested], ['/p/app/.wt/x/src'])]).toEqual(['/p/app/.wt/x']);
  });
});

describe('worktree paths', () => {
  it('slug replaces runs of unsafe characters', () => {
    expect(worktreeSlug('feature/login page')).toBe('feature-login-page');
    expect(worktreeSlug('v1.2_x-y')).toBe('v1.2_x-y');
    expect(worktreeSlug('a//b')).toBe('a-b');
  });
  it('folder name: detached uses the short sha', () => {
    expect(worktreeFolderName('fix/x', 'abc')).toBe('fix-x');
    expect(worktreeFolderName(null, 'abcdef1234')).toBe('detached-abcdef1');
  });
  it('expandHome', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/wt', '/h')).toBe('/h/wt');
    expect(expandHome('/a/~b', '/h')).toBe('/a/~b');
  });
  it('default path: next to the repo, or under the setting', () => {
    expect(defaultWorktreePath('/p/app', 'feat', '', '/h')).toBe('/p/app.worktrees/feat');
    expect(defaultWorktreePath('/p/app', 'feat', '~/trees', '/h')).toBe('/h/trees/app/feat');
    expect(defaultWorktreePath('/p/app', 'feat', '/abs', '/h')).toBe('/abs/app/feat');
    expect(defaultWorktreePath('/p/app', 'feat', '   ', '/h')).toBe('/p/app.worktrees/feat');
  });
  it('path validation', () => {
    const none = { exists: false, isDir: false, empty: false };
    expect(worktreePathError('', none, [])).toMatch(/provide a folder/);
    expect(worktreePathError('rel/x', none, [])).toMatch(/absolute/);
    expect(worktreePathError('/p/x', none, ['/p/x'])).toMatch(/already uses/);
    expect(worktreePathError('/p/x', { exists: true, isDir: true, empty: false }, [])).toMatch(/not empty/);
    expect(worktreePathError('/p/x', { exists: true, isDir: false, empty: false }, [])).toMatch(/not empty/);
    expect(worktreePathError('/p/x', { exists: true, isDir: true, empty: true }, [])).toBe('');
    expect(worktreePathError('/p/x', none, [])).toBe('');
  });
  it('arg: tree node, graph context or string', () => {
    expect(worktreePathFromArg('/p/x')).toBe('/p/x');
    expect(worktreePathFromArg({ kind: 'worktree', worktree: { path: '/p/y' } })).toBe('/p/y');
    expect(worktreePathFromArg({ webviewSection: 'worktree', path: '/p/z' })).toBe('/p/z');
    expect(worktreePathFromArg(undefined)).toBeUndefined();
    expect(worktreePathFromArg({})).toBeUndefined();
  });
});

describe('create entries', () => {
  const lb = (name: string, worktree: string | null) => ({ name, sha: 's', upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree });
  const refs: Refs = {
    head: { branch: 'main', sha: 'abc' },
    locals: [lb('main', '/p/app'), lb('dev', null), lb('feat', '/p/app.worktrees/feat')],
    remotes: [{ name: 'origin/main', sha: 's' }, { name: 'origin/HEAD', sha: 's' }, { name: 'origin/release', sha: 's' }],
    tags: [],
  };
  const list = [wt('/p/app', { main: true }), wt('/p/app.worktrees/feat', { branch: 'feat' })];

  it('new, free locals, busy locals, remotes without a local namesake', () => {
    const e = buildCreateEntries(refs, list);
    expect(e.map((x) => `${x.kind}:${x.label}`)).toEqual([
      'new:New branch…', 'separator:local branches', 'branch:dev', 'busy:main', 'busy:feat',
      'separator:remote branches', 'remote:origin/release',
    ]);
    expect(e[0]).toMatchObject({ description: 'from main' });
    expect(e.find((x) => x.label === 'feat')).toMatchObject({ description: 'in feat', worktree: '/p/app.worktrees/feat' });
    expect(e.find((x) => x.label === 'origin/release')).toMatchObject({ description: 'creates a tracking branch', local: 'release' });
  });
  it('from a commit: only New branch and Detached HEAD', () => {
    const e = buildCreateEntries(refs, list, { fromSha: 'abcdef1234567' });
    expect(e.map((x) => x.kind)).toEqual(['new', 'detached']);
    expect(e[0]).toMatchObject({ description: 'from abcdef1' });
  });
  it('detached HEAD: "from HEAD"', () => {
    expect(buildCreateEntries({ ...refs, head: { branch: null, sha: 'abc' }, locals: [], remotes: [] }, list)[0]).toMatchObject({ description: 'from HEAD' });
  });
});

describe('dialog texts', () => {
  it('remove detail mentions changes only when there are some', () => {
    expect(removeDetail('/p/x', 0)).toBe('The folder /p/x will be deleted.');
    expect(removeDetail('/p/x', 1)).toContain('1 uncommitted change; they will be lost.');
    expect(removeDetail('/p/x', 3)).toContain('3 uncommitted changes;');
  });
  it('prune detail lists the paths', () => {
    expect(pruneDetail(['/a', '/b'])).toContain('• /a\n• /b');
  });
});
