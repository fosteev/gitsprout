import { describe, expect, it } from 'vitest';
import {
  baseName, commitFilePlan, decodeQuery, isVolatileRef, diffTitle, encodeQuery, stagedPlan, stashFilePlan, unstagedPlan, uriParts, patchFileName, worktreeChanges,
} from '../src/diff/uri';

describe('diff uri', () => {
  it('round-trips awkward targets', () => {
    for (const t of [
      { root: '/Users/x/Projects/a b', ref: 'stash@{0}^1', path: 'src/ü ñ/a&b=c?d#e%f.ts' },
      { root: '/r', ref: ':', path: 'x' },
      { root: '/r', ref: '', path: 'only/name.php' },
    ]) {
      const q = encodeQuery(t);
      expect(q).not.toMatch(/[?#&= {}"]/);
      expect(decodeQuery(q)).toEqual(t);
    }
  });
  it('rejects malformed queries', () => {
    expect(decodeQuery('')).toBeUndefined();
    expect(decodeQuery('%E0%A4%A')).toBeUndefined();
    expect(decodeQuery(encodeURIComponent('{"root":1,"ref":"","path":""}'))).toBeUndefined();
    expect(decodeQuery(encodeURIComponent('null'))).toBeUndefined();
  });
  it('uri path keeps the file name', () => {
    const p = uriParts({ root: '/r', ref: 'abc', path: 'a/b/push_daemon.php' });
    expect(p).toMatchObject({ scheme: 'gitsprout', path: '/a/b/push_daemon.php' });
    expect(decodeQuery(p.query)).toEqual({ root: '/r', ref: 'abc', path: 'a/b/push_daemon.php' });
  });
  it('titles', () => {
    expect(baseName('a/b/c.php')).toBe('c.php');
    expect(baseName('c.php')).toBe('c.php');
    expect(diffTitle('a/push_daemon.php', 'Working Tree')).toBe('push_daemon.php (Working Tree)');
  });
});

const SHA = 'bb3c907aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAR = '06da7e4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('diff plans', () => {
  it('commit file: modified, added, deleted, renamed, root commit', () => {
    expect(commitFilePlan(SHA, { path: 'a/x.ts', origPath: null, status: 'M' }, PAR)).toEqual({
      kind: 'diff', left: { kind: 'git', ref: `${SHA}^`, path: 'a/x.ts' }, right: { kind: 'git', ref: SHA, path: 'a/x.ts' },
      title: 'x.ts (06da7e4 ↔ bb3c907)',
    });
    const added = commitFilePlan(SHA, { path: 'n.ts', origPath: null, status: 'A' }, PAR);
    expect(added).toMatchObject({ left: { ref: '', path: 'n.ts' }, right: { ref: SHA } });
    const del = commitFilePlan(SHA, { path: 'd.ts', origPath: null, status: 'D' }, PAR);
    expect(del).toMatchObject({ left: { ref: `${SHA}^`, path: 'd.ts' }, right: { ref: '', path: 'd.ts' } });
    const ren = commitFilePlan(SHA, { path: 'new/y.ts', origPath: 'old/y.ts', status: 'R' }, PAR);
    expect(ren).toMatchObject({ left: { ref: `${SHA}^`, path: 'old/y.ts' }, right: { ref: SHA, path: 'new/y.ts' } });
    const root = commitFilePlan(SHA, { path: 'r.ts', origPath: null, status: 'M' });
    expect(root).toMatchObject({ left: { ref: '' }, title: 'r.ts (empty ↔ bb3c907)' });
  });
  it('unstaged: index vs file; untracked opens; deleted on disk is empty on the right; conflict uses the index', () => {
    expect(unstagedPlan({ path: 'a/u.ts', status: 'M', untracked: false })).toEqual({
      kind: 'diff', left: { kind: 'git', ref: ':', path: 'a/u.ts' }, right: { kind: 'file', path: 'a/u.ts' }, title: 'u.ts (Working Tree)',
    });
    expect(unstagedPlan({ path: 'a/new.ts', status: 'A', untracked: true })).toEqual({ kind: 'open', path: 'a/new.ts' });
    expect(unstagedPlan({ path: 'gone.ts', status: 'D', untracked: false })).toMatchObject({ right: { kind: 'git', ref: '' } });
    expect(unstagedPlan({ path: 'c.ts', status: 'U', untracked: false })).toMatchObject({ left: { ref: ':' }, right: { kind: 'file' } });
  });
  it('staged: HEAD vs index; unborn and added have an empty left', () => {
    expect(stagedPlan({ path: 's.ts', origPath: null, status: 'M' }, false)).toEqual({
      kind: 'diff', left: { kind: 'git', ref: 'HEAD', path: 's.ts' }, right: { kind: 'git', ref: ':', path: 's.ts' }, title: 's.ts (Index)',
    });
    expect(stagedPlan({ path: 's.ts', origPath: null, status: 'M' }, true)).toMatchObject({ left: { ref: '' } });
    expect(stagedPlan({ path: 's.ts', origPath: null, status: 'A' }, false)).toMatchObject({ left: { ref: '' } });
    expect(stagedPlan({ path: 'b.ts', origPath: 'a.ts', status: 'R' }, false)).toMatchObject({ left: { ref: 'HEAD', path: 'a.ts' }, right: { ref: ':', path: 'b.ts' } });
    expect(stagedPlan({ path: 'd.ts', origPath: null, status: 'D' }, false)).toMatchObject({ right: { ref: '' } });
  });
  it('stash file: base vs stash commit; untracked from ^3', () => {
    const s2 = { index: 2, sha: 'c0ffee' };
    const s0 = { index: 0, sha: 'beef00' };
    expect(stashFilePlan(s2, { path: 'a/t.ts', origPath: null, status: 'M', untracked: false })).toEqual({
      kind: 'diff', left: { kind: 'git', ref: 'c0ffee^1', path: 'a/t.ts' }, right: { kind: 'git', ref: 'c0ffee', path: 'a/t.ts' }, title: 't.ts (stash@{2})',
    });
    expect(stashFilePlan(s0, { path: 'u.txt', origPath: null, status: 'A', untracked: true })).toMatchObject({
      left: { ref: '' }, right: { ref: 'beef00^3', path: 'u.txt' },
    });
    expect(stashFilePlan(s0, { path: 'n.txt', origPath: null, status: 'A', untracked: false })).toMatchObject({ left: { ref: '' }, right: { ref: 'beef00' } });
    expect(stashFilePlan(s0, { path: 'd.txt', origPath: null, status: 'D', untracked: false })).toMatchObject({ left: { ref: 'beef00^1' }, right: { ref: '' } });
  });

  it('only full commit ids (with a parent suffix) are stable refs', () => {
    const sha = 'a'.repeat(40);
    for (const ref of [sha, `${sha}^`, `${sha}^1`, `${sha}^3`, 'b'.repeat(64)]) expect(isVolatileRef(ref)).toBe(false);
    for (const ref of [':', 'HEAD', 'main', 'stash@{0}', 'stash@{0}^1', 'abc1234', 'HEAD^']) expect(isVolatileRef(ref)).toBe(true);
    expect(isVolatileRef('')).toBe(false);
  });
});

describe('worktree compare', () => {
  const sha = 'a'.repeat(40);
  it('builds sides per status', () => {
    const r = worktreeChanges(sha, [
      { path: 'm.ts', origPath: null, status: 'M' },
      { path: 'a.ts', origPath: null, status: 'A' },
      { path: 'd.ts', origPath: null, status: 'D' },
      { path: 'new.ts', origPath: 'old.ts', status: 'R' },
    ]);
    expect(r[0]).toEqual({ path: 'm.ts', left: { kind: 'git', ref: sha, path: 'm.ts' }, right: { kind: 'file', path: 'm.ts' } });
    expect(r[1].left).toEqual({ kind: 'git', ref: '', path: 'a.ts' });
    expect(r[1].right).toEqual({ kind: 'file', path: 'a.ts' });
    expect(r[2].left).toEqual({ kind: 'git', ref: sha, path: 'd.ts' });
    expect(r[2].right).toEqual({ kind: 'git', ref: '', path: 'd.ts' });
    expect(r[3].left).toEqual({ kind: 'git', ref: sha, path: 'old.ts' });
    expect(r[3].right).toEqual({ kind: 'file', path: 'new.ts' });
  });
  it('names patch files', () => {
    expect(patchFileName(sha, 'Fix: the "Bug" (#12)!')).toBe('aaaaaaa-fix-the-bug-12.patch');
    expect(patchFileName(sha, '日本語')).toBe('aaaaaaa.patch');
  });
});
