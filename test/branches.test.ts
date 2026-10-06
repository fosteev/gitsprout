import { describe, expect, it } from 'vitest';
import type { Commit, Refs } from '../src/git/types';
import { branchOwners, childrenOf, containedIn, mergedBranch } from '../webview/branches';

const c = (sha: string, parents: string[], subject = sha): Commit => ({ sha, parents, author: 'a', email: 'a@x', time: 0, subject, body: '' });
const refs = (locals: Record<string, string>, remotes: Record<string, string> = {}, tags: Record<string, string> = {}): Refs => ({
  head: { branch: null, sha: null },
  locals: Object.entries(locals).map(([name, sha]) => ({ name, sha, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null })),
  remotes: Object.entries(remotes).map(([name, sha]) => ({ name, sha })),
  tags: Object.entries(tags).map(([name, sha]) => ({ name, sha })),
});
const names = (commits: Commit[], r: Refs, headSha: string | null = null): Record<string, string | null> =>
  Object.fromEntries([...branchOwners(commits, r, { branch: null, sha: headSha })].map(([sha, o]) => [sha, o.name]));

describe('mergedBranch', () => {
  it.each([
    ["Merge branch 'feature/login' into develop", 'feature/login'],
    ["Merge branch 'fix' into 'main'", 'fix'],
    ["Merge branch 'main' of github.com:o/r", 'main'],
    ["Merge remote-tracking branch 'origin/release/2.0'", 'origin/release/2.0'],
    ['Merge pull request #42 from octo/feature/search', 'feature/search'],
    ['Merged in bugfix/x (pull request #7)', 'bugfix/x'],
    ["Merge branches 'a' and 'b'", null],
    ['Add login form', null],
  ])('%s → %s', (s, want) => expect(mergedBranch(s)).toBe(want));
});

describe('branchOwners', () => {
  // main: m3 ← m2 ← m1; feature forks at m1: f2 ← f1 ← m1
  const forked = [c('m3', ['m2']), c('f2', ['f1']), c('m2', ['m1']), c('f1', ['m1']), c('m1', [])];

  it('gives the fork point and below to the trunk, not to the feature branch', () => {
    expect(names(forked, refs({ feature: 'f2', main: 'm3' }))).toEqual({ m3: 'main', m2: 'main', m1: 'main', f2: 'feature', f1: 'feature' });
  });

  it('labels commits only on the remote trunk with the remote name', () => {
    expect(names(forked.filter((x) => x.sha[0] === 'm'), refs({ main: 'm2' }, { 'origin/main': 'm3' })))
      .toEqual({ m3: 'origin/main', m2: 'main', m1: 'main' });
  });

  it('leaves shared commits to the older of two feature branches', () => {
    // a: a1 ← m1; b continues a: b1 ← a1
    const cs = [c('b1', ['a1']), c('a1', ['m1']), c('m1', [])];
    expect(names(cs, refs({ b: 'b1', a: 'a1' }))).toEqual({ b1: 'b', a1: 'a', m1: 'a' });
  });

  it('names a deleted branch from the merge subject', () => {
    const cs = [c('M', ['m1', 'f2'], "Merge branch 'feature/x' into main"), c('f2', ['f1']), c('f1', ['m1']), c('m1', [])];
    const o = branchOwners(cs, refs({ main: 'M' }), { branch: null, sha: null });
    expect(o.get('f2')).toEqual({ name: 'feature/x', via: 'merge', into: 'main' });
    expect(o.get('f1')).toEqual({ name: 'feature/x', via: 'merge', into: 'main' });
    expect(o.get('m1')).toEqual({ name: 'main', via: 'ref' });
  });

  it('keeps the merge target when the subject names no branch, and prefers a live ref over the subject', () => {
    const cs = [c('M', ['m1', 'f1'], 'Squashed stuff'), c('f1', ['m1']), c('m1', [])];
    expect(branchOwners(cs, refs({ main: 'M' }), { branch: null, sha: null }).get('f1')).toEqual({ name: null, via: 'merge', into: 'main' });
    expect(names(cs, refs({ main: 'M', live: 'f1' }))).toMatchObject({ f1: 'live' });
  });

  it('falls back to tags and a detached HEAD', () => {
    const cs = [c('d', ['t']), c('t', ['m1']), c('m1', [])];
    expect(names(cs, refs({ main: 'm1' }, {}, { 'v1.0': 't' }), 'd')).toEqual({ d: 'HEAD', t: 'v1.0', m1: 'main' });
  });
});

describe('containedIn', () => {
  it('lists the branches whose history has the commit', () => {
    const cs = [c('m3', ['m2']), c('f2', ['f1']), c('m2', ['m1']), c('f1', ['m1']), c('m1', [])];
    const r = refs({ main: 'm3', feature: 'f2' }, { 'origin/main': 'm2' });
    const ch = childrenOf(cs);
    expect(containedIn('m1', ch, r)).toEqual(['main', 'feature', 'origin/main']);
    expect(containedIn('f1', ch, r)).toEqual(['feature']);
    expect(containedIn('m3', ch, r)).toEqual(['main']);
  });
});

describe('branchTipHtml', () => {
  it('shows the owner, a deleted branch and the other branches, escaped', async () => {
    const { branchTipHtml } = await import('../webview/render');
    const live = branchTipHtml({ name: 'feat/<x>', via: 'ref' }, 1, ['feat/<x>', 'main']);
    expect(live).toContain('ref c1');
    expect(live).toContain('feat/&lt;x&gt;');
    expect(live).toContain('Also in <b>main</b>');
    expect(branchTipHtml({ name: 'old', via: 'merge', into: 'main' }, 0, [])).toContain('Deleted branch, merged into main');
    expect(branchTipHtml({ name: null, via: 'merge', into: 'main' }, 0, [])).toContain('does not name the branch');
    expect(branchTipHtml(undefined, 0, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain('+2 more');
  });
});
