import { describe, expect, it } from 'vitest';
import type { LocalBranch } from '../src/git/types';
import {
  branchContext, branchDescription, buildBranchTree, buildRemoteTree, fileBase, fileDir, repoViewDescription, sortTags, stashFileRow, stashLabel,
} from '../src/views/refsModel';

const lb = (name: string, o: Partial<LocalBranch> = {}): LocalBranch =>
  ({ name, sha: 'a'.repeat(40), upstream: `origin/${name}`, ahead: 0, behind: 0, upstreamGone: false, worktree: null, ...o });

describe('branch rows', () => {
  it('descriptions', () => {
    expect(branchDescription(lb('x', { behind: 2, ahead: 1 }))).toBe('2↓ 1↑');
    expect(branchDescription(lb('x', { behind: 3 }))).toBe('3↓');
    expect(branchDescription(lb('x', { ahead: 4 }))).toBe('4↑');
    expect(branchDescription(lb('x'))).toBe('');
    expect(branchDescription(lb('x', { upstream: null }))).toBe('local only');
    expect(branchDescription(lb('x', { upstreamGone: true, ahead: 1 }))).toBe('gone');
  });
  it('context values', () => {
    expect(branchContext(true)).toBe('branch.local.head');
    expect(branchContext(false)).toBe('branch.local');
  });
  it('groups by the first slash only; folders first; marks HEAD', () => {
    const tree = buildBranchTree([lb('main'), lb('feature/a/b'), lb('feature/z'), lb('develop'), lb('bugfix/q'), lb('/odd'), lb('trail/')], 'feature/z');
    expect(tree.map((n) => (n.kind === 'folder' ? `${n.label}/[${n.children.map((c) => c.label).join(',')}]` : n.label)))
      .toEqual(['bugfix/[q]', 'feature/[a/b,z]', '/odd', 'develop', 'main', 'trail/']);
    const head = tree.flatMap((n) => (n.kind === 'folder' ? n.children : [n])).filter((n) => n.isHead);
    expect(head.map((n) => n.branch.name)).toEqual(['feature/z']);
  });
  it('detached HEAD marks nothing', () => {
    const tree = buildBranchTree([lb('main')], null);
    expect(tree[0]).toMatchObject({ kind: 'branch', isHead: false });
  });
});

describe('remotes, tags, stashes', () => {
  it('groups by remote and sorts numerically', () => {
    const t = buildRemoteTree([
      { name: 'origin/release/10', sha: 's1' }, { name: 'origin/release/9', sha: 's2' },
      { name: 'upstream/main', sha: 's3' }, { name: 'origin/develop', sha: 's4' },
    ]);
    expect(t.map((g) => g.name)).toEqual(['origin', 'upstream']);
    expect(t[0].children.map((c) => c.label)).toEqual(['develop', 'release/9', 'release/10']);
  });
  it('tags newest-looking first', () => {
    expect(sortTags([{ name: 'v1.9', sha: '' }, { name: 'v1.10', sha: '' }, { name: 'v1.2', sha: '' }]).map((t) => t.name)).toEqual(['v1.10', 'v1.9', 'v1.2']);
  });
  it('stash labels and file rows', () => {
    expect(stashLabel({ index: 3 })).toBe('stash@{3}');
    expect(fileDir('a/b/c.ts')).toBe('a/b');
    expect(fileDir('c.ts')).toBe('');
    expect(fileBase('a/b/c.ts')).toBe('c.ts');
    expect(stashFileRow({ path: 'a/b.ts', origPath: null, status: 'M', untracked: false })).toMatchObject({ label: 'b.ts', description: 'a', icon: 'diff-modified', tooltip: 'Modified: a/b.ts' });
    expect(stashFileRow({ path: 'n.txt', origPath: null, status: 'A', untracked: true }).tooltip).toBe('Untracked: n.txt');
    expect(stashFileRow({ path: 'b.ts', origPath: 'a.ts', status: 'R', untracked: false }).tooltip).toBe('Renamed: a.ts → b.ts');
  });
  it('view description only in multi-repo', () => {
    expect(repoViewDescription('web-app', true)).toBe('web-app');
    expect(repoViewDescription('web-app', false)).toBeUndefined();
    expect(repoViewDescription(undefined, true)).toBeUndefined();
  });
});
