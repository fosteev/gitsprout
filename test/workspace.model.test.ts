import { describe, expect, it } from 'vitest';
import type { RepoSummary } from '../src/git/types';
import { locate, mainRootOf, makeRepoSummary, repoDisplayName, repoForPath, sameSummary, scmDepthCheck, subOf } from '../src/workspace/model';
import { mapPool } from '../src/util/pool';
import { fetchRepos, summarizeFetch } from '../src/workspace/fetch';
import {
  buildPickEntries, buildRepoTree, needsAttention, repoDescription, statusBarModel, viewDescription,
  type RepoTreeNode,
} from '../src/views/repoModel';

const base = { branch: 'main', sha: 'abcdef1234', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 };
function repo(relPath: string, over: Partial<RepoSummary> = {}): RepoSummary {
  const segs = relPath.split('/');
  return { ...base, root: `/p/${relPath}`, name: segs[segs.length - 1], relPath, group: segs.length > 1 ? segs[0] : '', ...over };
}

describe('locate / summary', () => {
  const one = [{ name: 'Projects', path: '/p' }];
  it('single folder: relPath is relative, group = first segment', () => {
    expect(locate('/p/at/crm', one)).toEqual({ relPath: 'at/crm', group: 'at', depth: 2 });
    expect(locate('/p/at/a/b', one)).toEqual({ relPath: 'at/a/b', group: 'at', depth: 3 });
    expect(locate('/p/top', one)).toEqual({ relPath: 'top', group: '', depth: 1 });
    expect(locate('/p', one)).toEqual({ relPath: 'p', group: '', depth: 0 });
  });
  it('several folders: prefixed by the folder name; longest folder wins', () => {
    const many = [{ name: 'A', path: '/a' }, { name: 'B', path: '/a/b' }];
    expect(locate('/a/x', many)).toEqual({ relPath: 'A/x', group: 'A', depth: 1 });
    expect(locate('/a/b/y', many)).toEqual({ relPath: 'B/y', group: 'B', depth: 1 });
    expect(locate('/a/b', many)).toEqual({ relPath: 'B', group: '', depth: 0 });
  });
  it('does not treat sibling prefixes as inside', () => {
    expect(locate('/pp/x', one).depth).toBe(0);
  });
  it('subOf and makeRepoSummary', () => {
    expect(subOf('at/a/b')).toBe('a');
    expect(subOf('at/a/b/c')).toBe('a/b');
    expect(subOf('at/a')).toBe('');
    expect(subOf('top')).toBe('');
    const s = makeRepoSummary('/p/at/crm', one, base);
    expect(s).toMatchObject({ root: '/p/at/crm', name: 'crm', relPath: 'at/crm', group: 'at', branch: 'main' });
    expect(sameSummary(s, { ...base })).toBe(true);
    expect(sameSummary(s, { ...base, changes: 1 })).toBe(false);
  });
});

describe('repoForPath', () => {
  const roots = ['/p/at/crm', '/p/at/crm-extra', '/p/at'];
  it('picks the longest root on a path boundary', () => {
    expect(repoForPath(roots, '/p/at/crm/src/a.ts')).toBe('/p/at/crm');
    expect(repoForPath(roots, '/p/at/crm-extra/a.ts')).toBe('/p/at/crm-extra');
    expect(repoForPath(roots, '/p/at/other/a.ts')).toBe('/p/at');
    expect(repoForPath(roots, '/p/atx/a.ts')).toBeUndefined();
    expect(repoForPath(roots, '/p/at/crm')).toBe('/p/at/crm');
  });
});

describe('scmDepthCheck', () => {
  it('reports what the built-in SCM misses', () => {
    expect(scmDepthCheck([2, 2, 3, 1], 1)).toEqual({ visible: 1, total: 4, needed: 3 });
    expect(scmDepthCheck([2, 2, 3, 1], 3)).toBeNull();
    expect(scmDepthCheck([2, 3], -1)).toBeNull();
    expect(scmDepthCheck([], 1)).toBeNull();
    expect(scmDepthCheck([0, 1], 1)).toBeNull();
  });
});

describe('descriptions and filter', () => {
  it('formats branch* N↓ M↑', () => {
    expect(repoDescription(base)).toBe('main');
    expect(repoDescription({ ...base, changes: 3 })).toBe('main*');
    expect(repoDescription({ ...base, behind: 2, ahead: 1 })).toBe('main 2↓ 1↑');
    expect(repoDescription({ ...base, changes: 1, ahead: 4 })).toBe('main* 4↑');
    expect(repoDescription({ ...base, branch: null })).toBe('(abcdef1)');
    expect(repoDescription({ ...base, branch: null, sha: null })).toBe('HEAD');
  });
  it('needs attention: dirty, ahead or behind', () => {
    expect(needsAttention(base)).toBe(false);
    expect(needsAttention({ ...base, changes: 1 })).toBe(true);
    expect(needsAttention({ ...base, ahead: 1 })).toBe(true);
    expect(needsAttention({ ...base, behind: 1 })).toBe(true);
  });
  it('view description', () => {
    const rs = [repo('a/x'), repo('a/y', { changes: 2 }), repo('b/z', { behind: 1 })];
    expect(viewDescription(rs, false)).toBe('3 · 2 need attention');
    expect(viewDescription(rs, true)).toBe('3 · 2 need attention · filtered');
  });
});

describe('buildRepoTree', () => {
  const rs = [
    repo('labs/gamma'), repo('at/crm', { changes: 1 }), repo('at/legacy/old'), repo('at/legacy/older', { behind: 2 }),
    repo('at/alpha'), repo('top'), repo('topdirty', { ahead: 1 }),
  ];
  const labels = (ns: RepoTreeNode[]): unknown[] => ns.map((n) => n.kind === 'repo' ? (n.children.length ? { [n.repo.name]: labels(n.children) } : n.repo.name) : { [n.label]: labels(n.children) });

  it('groups, sub-folders and top-level repos, sorted', () => {
    expect(labels(buildRepoTree(rs, { onlyAttention: false }))).toEqual([
      { at: ['alpha', 'crm', { legacy: ['old', 'older'] }] },
      { labs: ['gamma'] },
      'top', 'topdirty',
    ]);
  });
  it('group descriptions count all repos and the ones needing attention', () => {
    const tree = buildRepoTree(rs, { onlyAttention: false });
    expect(tree.map((n) => n.kind !== 'repo' && n.description)).toEqual(['4 repos · 2 need attention', '1 repo', false, false]);
  });
  it('only-attention hides clean repos and empty groups, keeps the active repo', () => {
    expect(labels(buildRepoTree(rs, { onlyAttention: true }))).toEqual([
      { at: ['crm', { legacy: ['older'] }] }, 'topdirty',
    ]);
    expect(labels(buildRepoTree(rs, { onlyAttention: true, activeRoot: '/p/labs/gamma' }))).toEqual([
      { at: ['crm', { legacy: ['older'] }] }, { labs: ['gamma'] }, 'topdirty',
    ]);
  });
  it('keys are unique and stable', () => {
    const keys: string[] = [];
    const walk = (ns: RepoTreeNode[]) => ns.forEach((n) => { keys.push(n.key); walk(n.children); });
    walk(buildRepoTree(rs, { onlyAttention: false }));
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('empty input', () => { expect(buildRepoTree([], { onlyAttention: true })).toEqual([]); });

  describe('worktree nesting', () => {
    const wt = (relPath: string, of: string, over: Partial<RepoSummary> = {}) => repo(relPath, { worktreeOf: `/p/${of}`, ...over });
    const all = [repo('at/crm'), wt('at/crm.worktrees/fix', 'at/crm'), wt('labs/crm-feat', 'at/crm'), repo('top'), wt('orphan', 'gone/main')];

    it('nests linked worktrees under their main repo wherever they live; orphans stay put', () => {
      expect(labels(buildRepoTree(all, { onlyAttention: false }))).toEqual([
        { at: [{ crm: ['crm-feat', 'fix'] }] }, 'orphan', 'top',
      ]);
    });
    it('children use repo nodes with unique keys; group counts include them', () => {
      const tree = buildRepoTree(all, { onlyAttention: false });
      const crm = (tree[0] as { children: RepoTreeNode[] }).children[0];
      expect(crm.kind === 'repo' && crm.children.map((c) => c.kind)).toEqual(['repo', 'repo']);
      expect(tree[0].kind !== 'repo' && tree[0].description).toBe('3 repos');
    });
    it('only-attention keeps a clean main repo for a dirty worktree and hides clean worktrees', () => {
      const rs = [repo('at/crm'), wt('at/crm.worktrees/fix', 'at/crm', { changes: 1 }), wt('at/crm.worktrees/ok', 'at/crm')];
      expect(labels(buildRepoTree(rs, { onlyAttention: true }))).toEqual([{ at: [{ crm: ['fix'] }] }]);
      expect(labels(buildRepoTree([repo('a'), wt('a.worktrees/b', 'a')], { onlyAttention: true }))).toEqual([]);
    });
    it('the active worktree stays visible under the filter', () => {
      const rs = [repo('a'), wt('a.worktrees/b', 'a')];
      expect(labels(buildRepoTree(rs, { onlyAttention: true, activeRoot: '/p/a.worktrees/b' }))).toEqual([{ a: ['b'] }]);
    });
  });
});

describe('buildPickEntries', () => {
  it('separators per group, root group last, active flagged', () => {
    const e = buildPickEntries([repo('top'), repo('b/y', { behind: 1 }), repo('a/x', { changes: 2, ahead: 1 })], '/p/b/y');
    expect(e).toEqual([
      { kind: 'separator', label: 'a' },
      { kind: 'repo', label: 'x', description: 'main* 1↑ · a/x', root: '/p/a/x', active: false },
      { kind: 'separator', label: 'b' },
      { kind: 'repo', label: 'y', description: 'main 1↓ · b/y', root: '/p/b/y', active: true },
      { kind: 'separator', label: 'Workspace' },
      { kind: 'repo', label: 'top', description: 'main · top', root: '/p/top', active: false },
    ]);
  });
});

describe('statusBarModel', () => {
  it('hidden without repos, Gitsprout → graph for one, name → switch for many', () => {
    expect(statusBarModel([], undefined)).toBeNull();
    expect(statusBarModel([repo('a')], repo('a'))).toMatchObject({ text: '$(repo) Gitsprout', command: 'gitsprout.showGraph' });
    const two = [repo('a/x'), repo('a/y')];
    expect(statusBarModel(two, two[1])).toMatchObject({ text: '$(repo) y', command: 'gitsprout.switchRepository' });
    expect(statusBarModel(two, undefined)?.text).toBe('$(repo) Gitsprout');
    const linked = [repo('a/x'), repo('a/x.worktrees/fix', { worktreeOf: '/p/a/x' })];
    expect(statusBarModel(linked, linked[1])?.text).toBe('$(repo) x ⌥ fix');
  });
});

describe('mapPool', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('limits concurrency and keeps order', async () => {
    let cur = 0, max = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { cur++; max = Math.max(max, cur); await sleep(5 * (8 - n)); cur--; return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBe(3);
  });
  it('stops starting new items', async () => {
    let started = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 1, async (n) => { started++; return n; }, () => started >= 2);
    expect(out).toEqual([1, 2, undefined, undefined, undefined]);
  });
  it('handles empty input', async () => { expect(await mapPool([], 4, async () => 1)).toEqual([]); });
});

describe('fetchRepos / summarizeFetch', () => {
  const rs = [repo('a/x'), repo('a/y'), repo('a/z'), repo('a/w')];
  it('collects outcomes, reports progress, survives failures', async () => {
    const done: number[] = [];
    const { outcomes, skipped } = await fetchRepos(rs, 2, async (r) => { if (r.name === 'y') throw new Error('Could not resolve host'); }, { onDone: (_o, n) => done.push(n) });
    expect(skipped).toBe(0);
    expect(outcomes.map((o) => [o.name, o.ok])).toEqual([['x', true], ['y', false], ['z', true], ['w', true]]);
    expect(outcomes[1].error).toBe('Could not resolve host');
    expect(done.sort()).toEqual([1, 2, 3, 4]);
  });
  it('cancellation skips the rest', async () => {
    let n = 0;
    const { outcomes, skipped } = await fetchRepos(rs, 1, async () => { n++; }, { shouldStop: () => n >= 1 });
    expect(outcomes).toHaveLength(1);
    expect(skipped).toBe(3);
  });
  it('summary lists incoming repos like the prototype', () => {
    const after = [repo('a/x', { behind: 3 }), repo('a/y', { behind: 9 }), repo('a/z'), repo('a/w', { behind: 1, ahead: 2 })];
    const outcomes = after.map((r) => ({ root: r.root, name: r.name, ok: r.name !== 'y', error: r.name === 'y' ? 'offline' : undefined }));
    const s = summarizeFetch(outcomes, after);
    expect(s.text).toBe('Fetched 3 repositories. 2 have incoming commits: x 3↓, w 1↓. 1 failed: y (offline).');
    expect(s.incoming).toEqual(['/p/a/x', '/p/a/w']);
    expect(s.isError).toBe(false);
  });
  it('summary: nothing incoming, singular, all failed, cancelled', () => {
    const a = repo('a/x');
    expect(summarizeFetch([{ root: a.root, name: 'x', ok: true }], [a]).text).toBe('Fetched 1 repository. Nothing incoming.');
    expect(summarizeFetch([{ root: a.root, name: 'x', ok: true }], [{ ...a, behind: 1 }]).text).toBe('Fetched 1 repository. 1 has incoming commits: x 1↓.');
    const f = summarizeFetch([{ root: a.root, name: 'x', ok: false, error: 'auth' }], [a]);
    expect(f.isError).toBe(true);
    expect(f.text).toBe('Fetched 0 repositories. 1 failed: x (auth).');
    expect(summarizeFetch([{ root: a.root, name: 'x', ok: true }], [a], 5).text).toContain('Cancelled, 5 not fetched.');
  });
});

describe('worktree link', () => {
  it('mainRootOf: a linked worktree points at the folder that holds the common .git', () => {
    expect(mainRootOf('/p/app/.git/worktrees/x', '/p/app/.git')).toBe('/p/app');
  });
  it('mainRootOf: a main worktree, a bare common dir and a submodule have no main', () => {
    expect(mainRootOf('/p/app/.git', '/p/app/.git')).toBeUndefined();
    expect(mainRootOf('/p/app.git/worktrees/x', '/p/app.git')).toBeUndefined();
    expect(mainRootOf('/p/app/.git/modules/sub', '/p/app/.git/modules/sub')).toBeUndefined();
  });
  it('makeRepoSummary carries worktreeOf only when given', () => {
    const f = [{ name: 'p', path: '/p' }];
    expect(makeRepoSummary('/p/x', f, base).worktreeOf).toBeUndefined();
    expect('worktreeOf' in makeRepoSummary('/p/x', f, base)).toBe(false);
    expect(makeRepoSummary('/p/x', f, base, '/p/app').worktreeOf).toBe('/p/app');
  });
  it('repoDisplayName: `<main> ⌥ <name>` for a linked worktree', () => {
    expect(repoDisplayName('feature-x', '/p/app')).toBe('app ⌥ feature-x');
    expect(repoDisplayName('app')).toBe('app');
  });
});
