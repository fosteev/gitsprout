// Pure graph model: which commits are shown, lane assignment, and the per-row SVG.
// Ported from prototype/vscode-multi.html (visibleRows / layout / rowSvg); no DOM, unit-tested.
import type { Commit } from '../src/git/types';

export const LANE = 12;
export const RH = 26;
/** Lane colours cycle through `--g0..--g4` (VS Code's scmGraph.foreground1..5). */
export const LANE_COLORS = 5;
export const WIP_SHA = 'WIP';

export const laneX = (j: number): number => 8 + j * LANE;
export const graphWidth = (maxLanes: number): number => laneX(maxLanes - 1) + 10;

export interface Row {
  sha: string;
  /** Parents after CI hiding: hidden parents are replaced by their first visible ancestor. */
  parents: string[];
  commit?: Commit;
  wip?: true;
}

export interface VisibleOptions {
  hideCi: boolean;
  isCi: (c: Commit) => boolean;
  /** Commits that carry a ref (branch, remote, tag, HEAD): never hidden. */
  keep: ReadonlySet<string>;
  /** Parent of the WIP row; null = unborn branch. */
  headSha: string | null;
  /** Add the "Uncommitted Changes" row on top. */
  dirty: boolean;
}

export function visibleRows(commits: readonly Commit[], o: VisibleOptions): { rows: Row[]; hiddenN: number } {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const hidden = new Set<string>();
  if (o.hideCi) for (const c of commits) if (o.isCi(c) && !o.keep.has(c.sha)) hidden.add(c.sha);
  const vis = (s: string | undefined): string | undefined => {
    while (s && hidden.has(s)) s = bySha.get(s)?.parents[0];
    return s;
  };
  const rows: Row[] = commits.filter((c) => !hidden.has(c.sha)).map((c) => ({
    sha: c.sha,
    commit: c,
    parents: [...new Set(c.parents.map(vis).filter((p): p is string => !!p))],
  }));
  if (o.dirty) rows.unshift({ sha: WIP_SHA, wip: true, parents: o.headSha ? [o.headSha] : [] });
  return { rows, hiddenN: hidden.size };
}

export interface LaidRow extends Row {
  col: number;
  /** Lane contents above the node (sha awaited by the lane, `~sha` = dashed WIP lane, null = empty). */
  before: (string | null)[];
  /** Lanes the parent edges leave through below the node. */
  outs: number[];
}

export function layout(rows: readonly Row[]): { rows: LaidRow[]; max: number } {
  const lanes: (string | null)[] = [];
  const out: LaidRow[] = [];
  let max = 1;
  const free = (): number => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  const match = (v: string, sha: string): boolean => v === sha || v === '~' + sha;
  for (const r of rows) {
    const before = lanes.slice();
    const idxs: number[] = [];
    lanes.forEach((v, i) => { if (v && match(v, r.sha)) idxs.push(i); });
    const col = idxs.length ? idxs[0] : free();
    idxs.forEach((i) => { lanes[i] = null; });
    const outs: number[] = [];
    r.parents.forEach((p, pi) => {
      if (pi === 0) { lanes[col] = r.wip ? '~' + p : p; outs.push(col); }
      else {
        let k = lanes.findIndex((v) => !!v && match(v, p));
        if (k < 0) { k = free(); lanes[k] = p; }
        outs.push(k);
      }
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    max = Math.max(max, before.length, lanes.length, col + 1);
    out.push({ ...r, col, before, outs });
  }
  return { rows: out, max };
}

const laneVar = (j: number): string => `var(--g${j % LANE_COLORS})`;

/** SVG of one row: lanes passing through, edges to the parents, the node. `head`/`ci` pick the node style. */
export function rowSvg(r: LaidRow, width: number, o: { head: boolean; ci: boolean }): string {
  const cy = RH / 2;
  const seg = (x1: number, y1: number, x2: number, y2: number, j: number, dash: boolean): string => {
    const m = (y1 + y2) / 2;
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
    return `<path d="${d}" stroke="${laneVar(j)}"${dash ? ' stroke-dasharray="3 3"' : ''}/>`;
  };
  let s = '';
  r.before.forEach((v, j) => {
    if (!v) return;
    const dash = v[0] === '~';
    if (v === r.sha || v === '~' + r.sha) s += seg(laneX(j), 0, laneX(r.col), cy, j, dash);
    else s += seg(laneX(j), 0, laneX(j), RH, j, dash);
  });
  r.outs.forEach((k) => { s += seg(laneX(r.col), cy, laneX(k), RH, k, !!r.wip); });
  const c = laneVar(r.col);
  const x = laneX(r.col);
  let n: string;
  if (r.wip) n = `<circle cx="${x}" cy="${cy}" r="4.5" fill="var(--bg)" stroke="${c}" stroke-dasharray="2 2"/>`;
  else if (r.parents.length > 1) n = `<circle cx="${x}" cy="${cy}" r="3" fill="${c}" stroke="none"/>`;
  else if (o.ci) n = `<circle cx="${x}" cy="${cy}" r="3" fill="var(--bg)" stroke="${c}" stroke-width="1.5"/>`;
  else n = `<circle cx="${x}" cy="${cy}" r="4.5" fill="${c}" stroke="none"/>`;
  if (o.head) n = `<circle cx="${x}" cy="${cy}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5" opacity=".6"/>` + n;
  return `<svg width="${width}" height="${RH}" viewBox="0 0 ${width} ${RH}" fill="none" stroke-width="1.8" aria-hidden="true">${s}${n}</svg>`;
}
