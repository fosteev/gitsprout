import { describe, expect, it } from 'vitest';
import type { Worktree } from '../src/git/types';
import { graphWorktrees, needSummary } from '../src/graph/worktrees';

const w = (o: Partial<Worktree>): Worktree => ({ path: '/w/x', head: 'abc1234', branch: 'x', bare: false, main: false, locked: null, prunable: null, ...o });

describe('graphWorktrees', () => {
  const list = [w({ path: '/r', branch: 'main', main: true }), w({ path: '/w/feat', branch: 'feat' }), w({ path: '/w/gone', prunable: 'missing' }), w({ path: '/w/bare', bare: true, head: null, branch: null }), w({ path: '/w/det', branch: null, locked: '' })];

  it('drops missing and bare ones, names by folder, marks main and this tab\'s own', () => {
    const out = graphWorktrees(list, '/r', new Map([['/w/feat', 4]]), (a, b) => a === b);
    expect(out.map((x) => x.path)).toEqual(['/r', '/w/feat', '/w/det']);
    expect(out[0]).toMatchObject({ name: 'r', current: true, main: true, changes: 0 });
    expect(out[1]).toMatchObject({ name: 'feat', branch: 'feat', head: 'abc1234', current: false, main: false, changes: 4 });
    expect(out[2]).toMatchObject({ branch: null, current: false });
  });

  it('"current" goes through the injected path comparison (symlinks)', () => {
    const out = graphWorktrees(list, '/private/r', new Map(), (a, b) => a.replace('/private', '') === b.replace('/private', ''));
    expect(out.find((x) => x.current)?.path).toBe('/r');
  });
});

describe('needSummary', () => {
  const all = graphWorktrees(Array.from({ length: 14 }, (_, i) => w({ path: `/w/${i}` })), '/w/0', new Map(), (a, b) => a === b);

  it('skips the own worktree and the known ones, and caps the reads', () => {
    expect(needSummary(all, (p) => p === '/w/1')).toEqual(Array.from({ length: 10 }, (_, i) => `/w/${i + 2}`));
    expect(needSummary(all, () => true)).toEqual([]);
    expect(needSummary(all, () => false, 3)).toEqual(['/w/1', '/w/2', '/w/3']);
  });
});
