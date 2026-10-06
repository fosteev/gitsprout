// Pure HTML builders for the graph UI. Every piece of repository data (subjects, names, paths) goes through esc().
import type { CommitContext, GraphWorktree, WipContext, WorktreeAction, WorktreeContext } from '../src/graph/protocol';
import type { Commit, FileChange, FilePatch, FileStat, Head, Hunk, Refs, Status } from '../src/git/types';
import { esc, fmtAgo, fmtAgoLong, jiraUrl, minutesAgo, parseSubject, splitPath } from './format';
import type { Owner } from './branches';
import { LANE_COLORS, rowSvg, WIP_SHA, type LaidRow } from './layout';
import { buildTree, dirPaths, type TreeNode } from './wipTree';

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** `worktree` set: a local branch checked out in another worktree, or (kind 'worktree') that worktree's detached HEAD. */
export interface RefPill { kind: 'local' | 'remote' | 'tag' | 'worktree'; name: string; head: boolean; worktree?: { name: string; path: string } }

/**
 * Refs by the commit they point to; the checked-out branch comes first. `worktrees` (null = the Worktrees chip is off) marks
 * branches checked out in other worktrees and adds a pill for each other worktree's detached HEAD. A branch's worktree path and
 * `GraphWorktree.path` both come from git; whether a worktree is this tab's own is `GraphWorktree.current`, never a path
 * comparison here.
 */
export function refsBySha(refs: Refs, head: Head, worktrees: readonly GraphWorktree[] | null = null): Map<string, RefPill[]> {
  const m = new Map<string, RefPill[]>();
  const add = (sha: string, p: RefPill) => { const l = m.get(sha); if (l) l.push(p); else m.set(sha, [p]); };
  for (const b of refs.locals) {
    const isHead = b.name === head.branch;
    const pill: RefPill = { kind: 'local', name: b.name, head: isHead };
    if (worktrees && !isHead && b.worktree !== null) {
      const w = worktrees.find((x) => x.path === b.worktree);
      if (!w?.current) pill.worktree = { name: w?.name ?? baseName(b.worktree), path: b.worktree };
    }
    add(b.sha, pill);
  }
  for (const w of worktrees ?? []) {
    if (!w.current && w.branch === null && w.head) add(w.head, { kind: 'worktree', name: w.name, head: false, worktree: { name: w.name, path: w.path } });
  }
  for (const b of refs.remotes) add(b.sha, { kind: 'remote', name: b.name, head: false });
  for (const t of refs.tags) add(t.sha, { kind: 'tag', name: t.name, head: false });
  for (const l of m.values()) l.sort((a, b) => Number(b.head) - Number(a.head));
  return m;
}

/** Commits CI hiding must never hide: every ref tip (branch, remote, tag) and the HEAD commit. */
export function keepSet(pills: ReadonlyMap<string, RefPill[]>, head: Head): Set<string> {
  const keep = new Set(pills.keys());
  if (head.sha) keep.add(head.sha);
  return keep;
}

const ICONS = {
  check: '<path d="M3 8.5l3.2 3.2L13 5"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="5.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 7.2c0 3-7 1.4-7 3.6"/>',
  cloud: '<path d="M4.5 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 11.8 6.3a3.1 3.1 0 0 1-.3 6.2z"/>',
  tag: '<path d="M2 2h5.5L14 8.5 8.5 14 2 7.5z"/><circle cx="5" cy="5" r="1"/>',
  worktree: '<rect x="2" y="2.5" width="12" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
};
const icon = (name: keyof typeof ICONS): string =>
  `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

export function pillsHtml(pills: readonly RefPill[] | undefined, col: number): string {
  if (!pills) return '';
  return pills.map((p) => {
    const c = p.kind === 'tag' ? 'c0' : p.kind === 'remote' ? 'c5' : `c${col % LANE_COLORS}`;
    const ic = p.worktree ? 'worktree' : p.kind === 'remote' ? 'cloud' : p.kind === 'tag' ? 'tag' : p.head ? 'check' : 'branch';
    const title = !p.worktree ? p.name
      : p.kind === 'worktree' ? `Detached HEAD of worktree ${p.worktree.name} (${p.worktree.path})`
      : `Checked out in worktree ${p.worktree.name} (${p.worktree.path})`;
    return `<span class="ref ${c}${p.head ? ' head' : ''}${p.kind === 'tag' ? ' tag' : ''}${p.worktree ? ' other' : ''}" title="${esc(title)}">${icon(ic)}${esc(p.name)}</span>`;
  }).join('');
}

/** `KEY-123` chip + `[ KIND ]` tag + text. `link` makes the chip a button that opens Jira (details card only). */
export function subjectHtml(subject: string, jira: Record<string, string>, link: boolean): string {
  const p = parseSubject(subject);
  let h = '';
  if (p.key) {
    const url = link ? jiraUrl(p, jira) : undefined;
    h += url
      ? `<button class="jira" data-url="${esc(url)}" title="Open ${esc(p.key)} in Jira">${esc(p.key)}</button>`
      : `<span class="jira">${esc(p.key)}</span>`;
  }
  if (p.kind) h += `<span class="kind ${esc(p.kind)}">${esc(p.kind)}</span>`;
  return h + `<span class="t">${esc(p.rest)}</span>`;
}

export function commitContext(sha: string, root: string): CommitContext {
  return { webviewSection: 'commit', sha, root, preventDefaultContextMenuItems: true };
}

export function worktreeContext(path: string, root: string, main: boolean): WorktreeContext {
  return { webviewSection: 'worktree', path, root, worktreeMain: main, preventDefaultContextMenuItems: true };
}

export interface RowEnv {
  /** Root of the repo the graph shows; goes into every row's context. */
  root: string;
  width: number;
  selected: string | null;
  headSha: string | null;
  jira: Record<string, string>;
  pills: Map<string, RefPill[]>;
  isCi: (c: Commit) => boolean;
  /** Lower-cased search text; '' = no search. Non-matching rows are dimmed. */
  query: string;
  nowMs: number;
  /** changed files, for the WIP row */
  wipCount: number;
  /** the draft commit summary; the WIP row shows it, or `// WIP` when empty */
  wipSummary: string;
  /** Worktrees of the repo, for the other worktrees' WIP rows */
  worktrees: readonly GraphWorktree[];
}

export const WIP_LABEL = '// WIP';

export function rowMatches(c: Commit, q: string): boolean {
  return !q || c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q);
}

/** `3 uncommitted changes` */
export const changesLabel = (n: number): string => `${n} uncommitted change${n === 1 ? '' : 's'}`;

/** Another worktree's WIP row: read-only (no staging from here), a right click offers that worktree's commands. */
function worktreeWipRowHtml(r: LaidRow, e: RowEnv): string {
  const path = r.worktree as string;
  const w = e.worktrees.find((x) => x.path === path);
  const name = w?.name ?? baseName(path);
  return `<div class="gr owip${e.selected === r.sha ? ' on' : ''}" data-sha="${esc(r.sha)}" data-vscode-context="${esc(JSON.stringify(worktreeContext(path, e.root, w?.main ?? false)))}" title="${esc(path)}">`
    + rowSvg(r, e.width, { head: false, ci: false })
    + `<div class="gdesc"><span class="t"><span class="wtn">${icon('worktree')}${esc(name)}</span> · ${changesLabel(w?.changes ?? 0)}</span></div>`
    + '<div class="gwhen"></div><div class="gwho"></div><div class="gsha"></div></div>';
}

/** Details card of another worktree (selected through its WIP row). */
export function worktreeCardHtml(w: GraphWorktree): string {
  const where = w.branch !== null ? `${icon('branch')} ${esc(w.branch)}` : `detached HEAD ${esc((w.head ?? '').slice(0, 7))}`;
  const btn = (action: WorktreeAction, label: string, sec: boolean): string =>
    `<button class="vbtn${sec ? ' sec' : ''}" data-wt="${action}" data-path="${esc(w.path)}">${label}</button>`;
  return `<div class="wtcard"><h2>${icon('worktree')} ${esc(w.name)}${w.main ? ' <span class="muted">(main worktree)</span>' : ''}</h2>`
    + `<div class="path">${esc(w.path)}</div>`
    + `<div class="wtline">${where} · ${w.changes} change${w.changes === 1 ? '' : 's'}</div>`
    + `<div class="vbtns">${btn('openGraph', 'Open Graph', false)}${btn('openWindow', 'Open in New Window', true)}${btn('terminal', 'Open Terminal', true)}</div>`
    + '<div class="note">Staging belongs to that worktree\'s own graph tab: its index is separate.</div></div>';
}

export function rowHtml(r: LaidRow, e: RowEnv): string {
  if (r.worktree !== undefined) return worktreeWipRowHtml(r, e);
  if (r.wip) {
    return `<div class="gr${e.selected === WIP_SHA ? ' on' : ''}" data-sha="${WIP_SHA}">${rowSvg(r, e.width, { head: false, ci: false })}`
      + `<div class="gdesc"><span class="wip">${esc(e.wipSummary.trim() || WIP_LABEL)}</span><span class="kind">${e.wipCount} file${e.wipCount === 1 ? '' : 's'}</span></div><div class="gwhen">*</div><div class="gwho">*</div><div class="gsha">*</div></div>`;
  }
  const c = r.commit as Commit;
  const cls = c.parents.length > 1 ? 'merge' : e.isCi(c) ? 'ci' : '';
  const ago = fmtAgo(minutesAgo(c.time, e.nowMs));
  return `<div class="gr${e.selected === c.sha ? ' on' : ''}${rowMatches(c, e.query) ? '' : ' dim'}" data-sha="${c.sha}" data-vscode-context="${esc(JSON.stringify(commitContext(c.sha, e.root)))}">`
    + rowSvg(r, e.width, { head: c.sha === e.headSha, ci: e.isCi(c) })
    + `<div class="gdesc ${cls}">${pillsHtml(e.pills.get(c.sha), r.col)}${subjectHtml(c.subject, e.jira, false)}</div>`
    + `<div class="gwhen">${ago}</div><div class="gwho">${esc(c.author)}</div><div class="gsha">${c.sha.slice(0, 7)}</div></div>`;
}

const LETTER_TITLE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict' };

function fileRow(i: number, area: string, f: { path: string; origPath: string | null; status: string }, extraDesc: string, title: string): string {
  const [dir, base] = splitPath(f.path);
  return `<div class="tr" data-file="${i}" data-area="${area}" title="${esc(title)}"><span class="st ${esc(f.status)}" title="${esc(LETTER_TITLE[f.status] ?? '')}">${esc(f.status)}</span>`
    + `<span class="tl">${esc(base)}</span><span class="td">${esc(dir)}${extraDesc}</span></div>`;
}

export type FilesState = FileStat[] | 'loading' | { error: string };

export interface DetailsEnv {
  jira: Record<string, string>;
  pills: Map<string, RefPill[]>;
  nowMs: number;
  /** shas of the rows currently shown (CI-hidden ones excluded), for parent links */
  known: ReadonlySet<string>;
}

export function commitDetailsHtml(c: Commit, files: FilesState, e: DetailsEnv): string {
  const p = parseSubject(c.subject);
  const url = jiraUrl(p, e.jira);
  const mins = minutesAgo(c.time, e.nowMs);
  const when = new Date(c.time * 1000).toLocaleString();
  const merge = c.parents.length > 1;
  const pills = e.pills.get(c.sha);
  const parents = c.parents.map((s) => e.known.has(s)
    ? `<button class="lnk" data-select="${s}">${s.slice(0, 7)}</button>`
    : `<span class="sha7" title="Not in the shown history">${s.slice(0, 7)}</span>`).join(' ') || 'root commit';
  let tot = '';
  let list = '';
  if (files === 'loading') list = '<div class="note">Loading files…</div>';
  else if ('error' in files) list = `<div class="note err">Could not read the files: ${esc(files.error)}</div>`;
  else {
    const a = files.reduce((t, f) => t + (f.add ?? 0), 0);
    const d = files.reduce((t, f) => t + (f.del ?? 0), 0);
    if (files.length) tot = `<span class="add">+${a}</span> <span class="del">−${d}</span>`;
    list = files.map((f, i) => fileRow(i, 'commit', f,
      f.origPath ? ` · from ${esc(f.origPath)}` : '',
      `${f.path}${f.add === null ? '  binary' : `  +${f.add} −${f.del}`}`)).join('');
  }
  return `<div class="dh"><div class="row1">Commit <span class="sha">${c.sha}</span><button class="vbtn" data-copy="${c.sha}" title="Copy commit SHA">Copy SHA</button></div><h2>${subjectHtml(c.subject, e.jira, true)}</h2>`
    + `${c.body.trim() ? `<div class="body">${esc(c.body.trim())}</div>` : ''}</div>`
    + `<dl class="dmeta"><dt>Author</dt><dd title="${esc(c.email)}">${esc(c.author)}</dd><dt>Date</dt><dd title="${esc(when)}">${fmtAgoLong(mins)}</dd>`
    + `<dt>Parent${merge ? 's' : ''}</dt><dd>${parents}</dd>`
    + (pills?.length ? `<dt>Refs</dt><dd>${pillsHtml(pills, 0)}</dd>` : '')
    + (url ? `<dt>Jira</dt><dd><button class="jira" data-url="${esc(url)}">${esc(p.key)} ↗</button></dd>` : '')
    + `</dl><div class="dsec"><div class="dsec-h">${merge ? 'MERGE COMMIT' : 'FILES CHANGED'}<span class="n">${tot}</span></div>`
    + (merge ? `<div class="note">Joins <code>${c.parents[1].slice(0, 7)}</code> into <code>${c.parents[0].slice(0, 7)}</code>. The changes live in the merged commits.</div>` : '')
    + list + '</div>';
}

// ---- WIP panel (prototype: renderWip / wipFiles / wipCommit) ----

export type WipView = 'path' | 'tree';
/** What the user typed; persisted per tab. */
export interface WipDraft { summary: string; description: string; amend: boolean }

const wi = (d: string, w = 14): string =>
  `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const WI = {
  chevR: wi('<path d="m6 3.5 4.5 4.5L6 12.5"/>'),
  chevD: wi('<path d="m3.5 6 4.5 4.5L12.5 6"/>'),
  refresh: wi('<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>'),
  plus: wi('<path d="M8 3v10M3 8h10"/>'),
  minus: wi('<path d="M3 8h10"/>'),
  discard: wi('<path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7h-3M6 4 3.5 6.5 6 9"/>'),
  trash: wi('<path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9"/>'),
  file: wi('<path d="M9.5 1.5h-6v13h9V4.5zM9.5 1.5v3h3"/>'),
  folder: wi('<path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/>'),
  down: wi('<path d="M4 6l4 4 4-4"/>'),
  check: wi('<path d="M3 8.5l3.2 3.2L13 5"/>'),
  path: wi('<path d="M3 4.5h10M3 8h10M3 11.5h10"/>', 13),
  tree: wi('<path d="M3 3v9.5h3M3 7h3"/><rect x="7.5" y="5.5" width="6" height="3" rx=".5"/><rect x="7.5" y="11" width="6" height="3" rx=".5"/><rect x="1.5" y="1" width="4" height="2.5" rx=".5"/>', 13),
};

const ib = (act: string, title: string, attrs = '', cls = ''): string => {
  const ico = act === 'refresh' ? WI.refresh : act === 'discardAll' ? WI.trash : act === 'stage' ? WI.plus : act === 'unstage' ? WI.minus : WI.discard;
  return `<button class="ib${cls}" data-act="${act}"${attrs} title="${esc(title)}" aria-label="${esc(title)}">${ico}</button>`;
};

/** Number of changed files; a partly staged file counts once (as Discard All's confirmation does). */
export function wipFileCount(wip: Status): number {
  return new Set([...wip.staged, ...wip.unstaged].map((f) => f.path)).size;
}

/** Discard is offered on unstaged rows only: not on a conflict (`U`) and not on a nested repository (`path/`). */
export function canDiscard(f: FileChange): boolean {
  return f.status !== 'U' && !f.path.endsWith('/');
}

/** `branch` is what the header shows after "on" (a branch name, `detached HEAD` or `no commits yet`). */
export function wipHeaderHtml(n: number, branch: string): string {
  return `<div class="wph">${ib('discardAll', 'Discard All Changes', '', ' danger')}`
    + `<span class="t">${n} file change${n === 1 ? '' : 's'} on <span class="brp">${esc(branch)}</span></span>${ib('refresh', 'Refresh')}</div>`;
}

/** Collapse/Expand All (tree only, when there are folders) and the Path/Tree switch. */
export function wipBarHtml(view: WipView, hasDirs: boolean, anyOpen: boolean): string {
  return `<div class="wpbar">${view === 'tree' && hasDirs ? `<button class="lnk" data-act="collapse">${anyOpen ? 'Collapse All' : 'Expand All'}</button>` : ''}`
    + `<span class="seg"><button data-act="view" data-view="path" aria-pressed="${view === 'path'}">${WI.path} Path</button>`
    + `<button data-act="view" data-view="tree" aria-pressed="${view === 'tree'}">${WI.tree} Tree</button></span></div>`;
}

/** Collapsed-set key of a folder row (the same path may exist in both lists). */
export const dirKey = (area: 'staged' | 'unstaged', path: string): string => `${area}:${path}`;
export const sectionKey = (area: 'staged' | 'unstaged'): string => `sec:${area}`;

/** All folder keys of both lists in the given status (what Collapse All / Expand All toggle). */
export function wipDirKeys(wip: Status): string[] {
  return (['unstaged', 'staged'] as const).flatMap((area) => dirPaths(buildTree(wip[area])).map((p) => dirKey(area, p)));
}

export function wipContext(root: string, area: 'staged' | 'unstaged', path: string, dir: boolean, f?: FileChange): WipContext {
  return {
    webviewSection: 'wip', root, wipArea: area, path, origPath: f?.origPath ?? null, wipDir: dir,
    wipCanDiscard: !!f && area === 'unstaged' && canDiscard(f), preventDefaultContextMenuItems: true,
  };
}

const ctxAttr = (c: WipContext): string => ` data-vscode-context="${esc(JSON.stringify(c))}"`;

function wipFileRow(root: string, f: FileChange, i: number, area: 'staged' | 'unstaged', depth: number, label: string, desc: string, spacer: boolean): string {
  const acts = area === 'staged'
    ? ib('unstage', 'Unstage File', ` data-area="staged" data-file="${i}"`)
    : (canDiscard(f) ? ib('discard', 'Discard Changes', ` data-area="unstaged" data-file="${i}"`) : '') + ib('stage', 'Stage File', ` data-area="unstaged" data-file="${i}"`);
  const extra = f.origPath ? ` · from ${esc(f.origPath)}` : f.untracked ? ' · untracked' : '';
  const title = f.untracked ? 'Untracked' : LETTER_TITLE[f.status] ?? '';
  return `<div class="tr w" data-file="${i}" data-area="${area}" data-d="${depth}" title="${esc(f.path)}"${ctxAttr(wipContext(root, area, f.path, false, f))}>${spacer ? '<span class="tw"></span>' : ''}`
    + `<span class="ti">${WI.file}</span><span class="tl">${esc(label)}</span><span class="td">${esc(desc)}${extra}</span><span class="ta">${acts}</span>`
    + `<span class="st ${esc(f.status)}" title="${esc(title)}">${esc(f.status)}</span></div>`;
}

function wipTreeRows(root: string, nodes: TreeNode[], area: 'staged' | 'unstaged', depth: number, collapsed: ReadonlySet<string>): string {
  return nodes.map((n) => {
    if (n.kind === 'file') return wipFileRow(root, n.file, n.index, area, depth, n.name, '', true);
    const key = dirKey(area, n.path);
    const open = !collapsed.has(key);
    return `<div class="tr w dir" data-act="dir" data-key="${esc(key)}" data-d="${depth}" role="button" aria-expanded="${open}" title="${esc(n.path)}"${ctxAttr(wipContext(root, area, n.path, true))}>`
      + `<span class="tw">${open ? WI.chevD : WI.chevR}</span><span class="ti">${WI.folder}</span><span class="tl">${esc(n.label)}</span></div>`
      + (open ? wipTreeRows(root, n.children, area, depth + 1, collapsed) : '');
  }).join('');
}

/** The Unstaged and Staged sections. Re-rendered on every `state`; `collapsed` holds section and folder keys; `root` goes into the rows' context. */
export function wipListsHtml(wip: Status, view: WipView, collapsed: ReadonlySet<string>, root = ''): string {
  const section = (area: 'staged' | 'unstaged', title: string, btn: string, empty: string): string => {
    const files = wip[area];
    const key = sectionKey(area);
    const open = !collapsed.has(key);
    let body = '';
    if (open) {
      if (!files.length) body = `<div class="empty">${esc(empty)}</div>`;
      else if (view === 'path') {
        body = files.map((f, i) => { const [dir, base] = splitPath(f.path); return wipFileRow(root, f, i, area, 0, base || f.path, dir, false); }).join('');
      } else body = wipTreeRows(root, buildTree(files).children, area, 0, collapsed);
    }
    return `<div class="wps${open ? '' : ' closed'}" data-area="${area}"><div class="wpsh" data-act="sec" data-key="${key}" role="button" aria-expanded="${open}">${open ? WI.chevD : WI.chevR}`
      + `<span>${title}</span><span class="n">(${files.length})</span>${files.length ? btn : ''}</div>${open ? `<div class="wpb">${body}</div>` : ''}</div>`;
  };
  // the sash between the two lists only makes sense while both are expanded
  const sash = collapsed.has(sectionKey('unstaged')) || collapsed.has(sectionKey('staged')) ? ''
    : '<div class="hsash" title="Drag to resize, double-click to reset"></div>';
  return section('unstaged', 'Unstaged Files', '<button class="go" data-act="stageAll">Stage All Changes</button>', 'No unstaged changes')
    + sash
    + section('staged', 'Staged Files', '<button class="go un" data-act="unstageAll">Unstage All</button>',
      wip.unstaged.length ? 'Stage files to include them in the commit' : 'No staged changes');
}

export interface PrimaryButton {
  kind: 'amend' | 'commit' | 'stage';
  label: string;
  /** the ▾ menu with "Commit and Push" is offered (never while amending: no force push) */
  menu: boolean;
}

/** The primary button of the commit box: Amend / Commit Changes to N File(s) / Stage Changes to Commit (stages all, does not commit). */
export function wipPrimary(amend: boolean, staged: number): PrimaryButton {
  if (amend) return { kind: 'amend', label: 'Amend Previous Commit', menu: false };
  if (staged > 0) return { kind: 'commit', label: `Commit Changes to ${staged} File${staged === 1 ? '' : 's'}`, menu: true };
  return { kind: 'stage', label: 'Stage Changes to Commit', menu: false };
}
export const primaryInnerHtml = (p: PrimaryButton): string => `${p.kind === 'stage' ? WI.plus : WI.check} ${esc(p.label)}`;
export const primaryClass = (p: PrimaryButton): string => `vbtn${p.kind === 'stage' ? ' stage' : ''}`;

export const SUMMARY_LIMIT = 72;
export const HEAD_PUSHED_NOTE = 'HEAD is already pushed. Amending rewrites it; pushing will need --force.';
export const NO_SUMMARY_ERROR = 'Enter a commit summary.';

export interface CommitCtx { staged: number; unborn: boolean; busy: boolean; headPushed: boolean; error: string }

/**
 * The commit box. Built once per WIP selection; afterwards main.ts only patches the pieces that carry an id
 * (#wamend, #wamendnote, #wbox, #wcnt, #werr, #wprimary, #wmore, #wmenu) so typing, focus and caret survive a `state`.
 */
export function wipCommitHtml(d: WipDraft, c: CommitCtx): string {
  const p = wipPrimary(d.amend, c.staged);
  const left = SUMMARY_LIMIT - d.summary.length;
  const dis = c.busy ? ' disabled' : '';
  // the HTML parser drops one leading newline inside <textarea>, so always emit one
  return `<div class="wpc">`
    + `<label class="amend"><input type="checkbox" id="wamend"${d.amend ? ' checked' : ''}${c.busy || c.unborn ? ' disabled' : ''}> Amend previous commit</label>`
    + `<div class="note" id="wamendnote"${d.amend && c.headPushed ? '' : ' hidden'}>${HEAD_PUSHED_NOTE}</div>`
    + `<div class="cbox${c.error ? ' bad' : ''}" id="wbox"><div class="sumrow"><input id="wsum" placeholder="Commit summary" value="${esc(d.summary)}" autocomplete="off" aria-label="Commit summary">`
    + `<span id="wcnt" class="cnt${left < 0 ? ' over' : ''}" title="Characters left before ${SUMMARY_LIMIT}">${left}</span></div>`
    + `<textarea id="wdesc" placeholder="Description" aria-label="Commit description">\n${esc(d.description)}</textarea></div>`
    + `<div class="verr" id="werr"${c.error ? '' : ' hidden'}>${esc(c.error)}</div>`
    + `<div class="vbtns"><button class="${primaryClass(p)}" id="wprimary" data-act="primary"${dis}>${primaryInnerHtml(p)}</button>`
    + `<button class="vbtn dd" id="wmore" data-act="menu" aria-label="More commit actions"${p.menu ? '' : ' hidden'}${dis}>${WI.down}</button></div>`
    + `<div class="wmenu" id="wmenu" role="menu" hidden><button data-act="commit" role="menuitem"${dis}>Commit <span class="k">⌘↵</span></button>`
    + `<button data-act="commitPush" role="menuitem"${dis}>Commit and Push</button></div></div>`;
}

export const noDetailsHtml = '<div class="nodetail">Select a commit to see its details</div>';

/** The picked file of the WIP list. */
export function wipFile(wip: Status, area: string, i: number): FileChange | undefined {
  return (area === 'staged' ? wip.staged : wip.unstaged)[i];
}

// ---- Inline diff (replaces the graph while open; prototype: .diff / .inl / .sbs) ----

export type DiffMode = 'inline' | 'split';
export type DiffBody = 'loading' | { error: string } | FilePatch;

export const DIFF_TRUNCATED_NOTE = 'Diff truncated at 10 000 lines — Open in Editor for the full diff.';

export interface DiffBar {
  status: string;
  path: string;
  origPath: string | null;
  /** `<parent7> ↔ <sha7>`, `empty ↔ <sha7>`, `Staged`, `Working Tree` or `Untracked` */
  label: string;
  mode: DiffMode;
  hasPrev: boolean;
  hasNext: boolean;
}

export function diffBarHtml(b: DiffBar): string {
  const [dir, base] = splitPath(b.path);
  const from = b.origPath ? ` (from ${b.origPath})` : '';
  const other = b.mode === 'split' ? 'Inline' : 'Split';
  return `<span class="st ${esc(b.status)}" title="${esc(LETTER_TITLE[b.status] ?? '')}">${esc(b.status)}</span>`
    + `<span class="dpath" title="${esc(b.path + from)}">${dir ? `<span class="ddir">${esc(dir)}/</span>` : ''}<b>${esc(base)}</b></span>`
    + `<span class="dctx">${esc(b.label)}</span><span class="dsp"></span>`
    + `<button class="ib" data-dact="prev" title="Previous file (k)"${b.hasPrev ? '' : ' disabled'}>‹</button>`
    + `<button class="ib" data-dact="next" title="Next file (j)"${b.hasNext ? '' : ' disabled'}>›</button>`
    + `<button class="vchip" data-dact="mode" aria-pressed="${b.mode === 'split'}" title="Switch to ${other}">${b.mode === 'split' ? 'Split' : 'Inline'}</button>`
    + '<button class="vchip" data-dact="editor" title="Open in the diff editor">Open in Editor</button>'
    + '<button class="ib" data-dact="close" title="Close (Esc)">✕</button>';
}

const num = (n: number | null): string => (n === null ? '' : String(n));

function inlineRowsHtml(hunks: Hunk[]): string {
  return hunks.map((h) => `<span class="dfold">${esc(h.header)}</span>` + h.lines.map((l) => {
    const c = l.kind === '+' ? ' ins' : l.kind === '-' ? ' rem' : '';
    return `<span class="dn${c}">${num(l.old)}</span><span class="dn${c}">${num(l.new)}</span><span class="dg${c}">${l.kind === ' ' ? '' : l.kind}</span><span class="dc${c}">${esc(l.text)}</span>`;
  }).join('')).join('');
}

const fill = (right: boolean): string => `<span class="dn fill${right ? ' dr' : ''}"></span><span class="dc fill"></span>`;

function splitRowsHtml(hunks: Hunk[]): string {
  return hunks.map((h) => {
    let out = `<span class="dfold">${esc(h.header)}</span>`;
    const ls = h.lines;
    for (let i = 0; i < ls.length;) {
      if (ls[i].kind === ' ') {
        const l = ls[i++];
        out += `<span class="dn">${num(l.old)}</span><span class="dc">${esc(l.text)}</span><span class="dn dr">${num(l.new)}</span><span class="dc">${esc(l.text)}</span>`;
        continue;
      }
      // a run of removals followed by a run of additions is shown side by side, row by row
      const dels: typeof ls = [];
      const adds: typeof ls = [];
      while (i < ls.length && ls[i].kind === '-') dels.push(ls[i++]);
      while (i < ls.length && ls[i].kind === '+') adds.push(ls[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        out += (d ? `<span class="dn rem">${num(d.old)}</span><span class="dc rem">${esc(d.text)}</span>` : fill(false))
          + (a ? `<span class="dn ins dr">${num(a.new)}</span><span class="dc ins">${esc(a.text)}</span>` : fill(true));
      }
    }
    return out;
  }).join('');
}

export function diffBodyHtml(body: DiffBody, mode: DiffMode): string {
  if (body === 'loading') return '<div class="dnote">Loading…</div>';
  if ('error' in body) return `<div class="dnote err">${esc(body.error)}</div>`;
  if (body.binary) return '<div class="dnote">Binary file — not shown.</div>';
  if (body.hunks.length === 0) return '<div class="dnote">No content changes.</div>';
  return `<div class="dgrid ${mode === 'split' ? 'dsbs' : 'dinl'}">${mode === 'split' ? splitRowsHtml(body.hunks) : inlineRowsHtml(body.hunks)}</div>`
    + (body.truncated ? `<div class="dnote">${DIFF_TRUNCATED_NOTE}</div>` : '');
}

const ALSO_IN_MAX = 5;

/** Hover card of a graph node: the branch the commit was made on (inferred, see branches.ts) and the other branches holding it. */
export function branchTipHtml(o: Owner | undefined, col: number, contained: readonly string[]): string {
  const pill = (name: string, cls: string): string => `<span class="ref ${cls}">${icon('branch')}${esc(name)}</span>`;
  let h = '';
  if (!o) h = '<div class="bnote">No branch in the loaded history</div>';
  else if (o.via === 'ref') h = pill(o.name, `c${col % LANE_COLORS}`) + (o.name === 'HEAD' ? '<div class="bnote">Detached HEAD</div>' : '');
  else if (o.name) h = pill(o.name, `c${col % LANE_COLORS} gone`) + `<div class="bnote">Deleted branch, merged into ${esc(o.into)}</div>`;
  else h = `<div class="bnote">Merged into ${esc(o.into)}; the merge message does not name the branch</div>`;
  const also = contained.filter((n) => n !== o?.name);
  if (also.length) {
    const more = also.length > ALSO_IN_MAX ? ` +${also.length - ALSO_IN_MAX} more` : '';
    h += `<div class="bnote">Also in ${also.slice(0, ALSO_IN_MAX).map((n) => `<b>${esc(n)}</b>`).join(', ')}${more}</div>`;
  }
  return h;
}
