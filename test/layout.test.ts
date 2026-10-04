import { describe, expect, it } from 'vitest';
import type { Commit } from '../src/git/types';
import { graphWidth, laneX, layout, rowSvg, visibleRows, WIP_SHA, type VisibleOptions } from '../webview/layout';

const c = (sha: string, parents: string[], subject = sha): Commit => ({ sha, parents, author: 'a', email: 'a@x', time: 0, subject, body: '' });
const opts = (o: Partial<VisibleOptions> = {}): VisibleOptions => ({
  hideCi: false, isCi: (x) => x.subject === 'AutoBuild', keep: new Set(), headSha: null, dirty: false, ...o,
});
const lay = (commits: Commit[], o: Partial<VisibleOptions> = {}) => layout(visibleRows(commits, opts(o)).rows);

describe('layout', () => {
  it('keeps a linear history in one lane', () => {
    const l = lay([c('c', ['b']), c('b', ['a']), c('a', [])]);
    expect(l.rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(l.rows.map((r) => r.outs)).toEqual([[0], [0], []]);
    expect(l.rows.map((r) => r.before)).toEqual([[], ['b'], ['a']]);
    expect(l.max).toBe(1);
  });

  it('branches and merges: the merge opens a second lane that closes at the fork point', () => {
    // m merges f (feature) into main; both descend from base.
    const l = lay([c('m', ['p', 'f']), c('f', ['base']), c('p', ['base']), c('base', [])]);
    const [m, f, p, base] = l.rows;
    expect(m.col).toBe(0);
    expect(m.outs).toEqual([0, 1]);
    expect(f.col).toBe(1);
    expect(f.outs).toEqual([1]);
    expect(p.col).toBe(0);
    expect(p.before).toEqual(['p', 'base']);
    // base is awaited by both lanes; the node takes the first, both lanes end here
    expect(base.col).toBe(0);
    expect(base.before).toEqual(['base', 'base']);
    expect(base.outs).toEqual([]);
    expect(l.max).toBe(2);
  });

  it('two lanes into one parent: separate lanes converge on the parent row', () => {
    // a and b are two tips with the same parent r.
    const l = lay([c('a', ['r']), c('b', ['r']), c('r', [])]);
    const [a, b, r] = l.rows;
    expect(a.col).toBe(0);
    expect(b.col).toBe(1);               // a's lane waits for r, b needs a free one
    expect(b.outs).toEqual([1]);
    expect(r.col).toBe(0);
    expect(r.before).toEqual(['r', 'r']); // both lanes converge on r
  });

  it('draws the WIP row first, with a dashed lane to HEAD', () => {
    const { rows } = visibleRows([c('h', [])], opts({ dirty: true, headSha: 'h' }));
    expect(rows[0]).toMatchObject({ sha: WIP_SHA, wip: true, parents: ['h'] });
    const l = layout(rows);
    expect(l.rows[0].outs).toEqual([0]);
    expect(l.rows[1].before).toEqual(['~h']);
    expect(l.rows[1].col).toBe(0);
    expect(rowSvg(l.rows[0], 30, { head: false, ci: false })).toContain('stroke-dasharray="3 3"');
    expect(rowSvg(l.rows[1], 30, { head: true, ci: false })).toContain('stroke-dasharray="3 3"'); // dashed lane arrives at HEAD
  });

  it('WIP on an unborn branch has no parent', () => {
    const { rows } = visibleRows([], opts({ dirty: true, headSha: null }));
    expect(rows).toEqual([{ sha: WIP_SHA, wip: true, parents: [] }]);
    expect(layout(rows).max).toBe(1);
  });

  it('leaves a lane open for a parent beyond the loaded set', () => {
    const l = lay([c('b', ['gone']), c('x', [])]);
    expect(l.rows[0].outs).toEqual([0]);
    expect(l.rows[1].before).toEqual(['gone']); // lane keeps running to the bottom
    expect(l.rows[1].col).toBe(1);
  });
});

describe('visibleRows: hiding CI commits', () => {
  const ci = (sha: string, parents: string[]) => c(sha, parents, 'AutoBuild');

  it('re-links the child to the first visible ancestor', () => {
    // top -> ci2 -> ci1 -> base
    const { rows, hiddenN } = visibleRows([c('top', ['ci2']), ci('ci2', ['ci1']), ci('ci1', ['base']), c('base', [])], opts({ hideCi: true }));
    expect(rows.map((r) => r.sha)).toEqual(['top', 'base']);
    expect(rows[0].parents).toEqual(['base']);
    expect(hiddenN).toBe(2);
  });

  it('never hides commits that carry a ref', () => {
    const { rows, hiddenN } = visibleRows([c('top', ['ci1']), ci('ci1', ['base']), c('base', [])], opts({ hideCi: true, keep: new Set(['ci1']) }));
    expect(rows.map((r) => r.sha)).toEqual(['top', 'ci1', 'base']);
    expect(hiddenN).toBe(0);
  });

  it('deduplicates parents that collapse into one and drops ones that vanish', () => {
    const merge = c('m', ['ci1', 'base']);
    const { rows } = visibleRows([merge, ci('ci1', ['base']), c('base', ['gone'])], opts({ hideCi: true }));
    expect(rows[0].parents).toEqual(['base']);
    const root = visibleRows([c('t', ['ci1']), ci('ci1', [])], opts({ hideCi: true })).rows;
    expect(root[0].parents).toEqual([]);
  });

  it('does nothing when hideCi is off', () => {
    const { rows, hiddenN } = visibleRows([ci('x', [])], opts());
    expect(rows).toHaveLength(1);
    expect(hiddenN).toBe(0);
  });
});

describe('geometry', () => {
  it('uses the prototype lane spacing', () => {
    expect(laneX(0)).toBe(8);
    expect(laneX(2)).toBe(32);
    expect(graphWidth(1)).toBe(18);
  });

  it('styles nodes: merge, CI, head ring', () => {
    const l = layout(visibleRows([c('m', ['a', 'b']), c('a', []), c('b', [])], opts()).rows);
    expect(rowSvg(l.rows[0], 40, { head: false, ci: false })).toContain('r="3" fill="var(--g0)"');
    expect(rowSvg(l.rows[1], 40, { head: false, ci: true })).toContain('stroke-width="1.5"');
    expect(rowSvg(l.rows[1], 40, { head: true, ci: false })).toContain('r="7.5"');
  });
});
