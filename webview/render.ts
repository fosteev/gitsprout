// Pure HTML builders for the graph UI. Every piece of repository data (subjects, names, paths) goes through esc().
import type { CommitContext } from '../src/graph/protocol';
import type { Commit, FileChange, FileStat, Head, Refs, Status } from '../src/git/types';
import { esc, fmtAgo, fmtAgoLong, jiraUrl, minutesAgo, parseSubject, splitPath } from './format';
import { LANE_COLORS, rowSvg, WIP_SHA, type LaidRow } from './layout';

export interface RefPill { kind: 'local' | 'remote' | 'tag'; name: string; head: boolean }

/** Refs by the commit they point to; the checked-out branch comes first. */
export function refsBySha(refs: Refs, head: Head): Map<string, RefPill[]> {
  const m = new Map<string, RefPill[]>();
  const add = (sha: string, p: RefPill) => { const l = m.get(sha); if (l) l.push(p); else m.set(sha, [p]); };
  for (const b of refs.locals) add(b.sha, { kind: 'local', name: b.name, head: b.name === head.branch });
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
};
const icon = (name: keyof typeof ICONS): string =>
  `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

export function pillsHtml(pills: readonly RefPill[] | undefined, col: number): string {
  if (!pills) return '';
  return pills.map((p) => {
    const c = p.kind === 'tag' ? 'c0' : p.kind === 'remote' ? 'c5' : `c${col % LANE_COLORS}`;
    const ic = p.kind === 'remote' ? 'cloud' : p.kind === 'tag' ? 'tag' : p.head ? 'check' : 'branch';
    return `<span class="ref ${c}${p.head ? ' head' : ''}${p.kind === 'tag' ? ' tag' : ''}" title="${esc(p.name)}">${icon(ic)}${esc(p.name)}</span>`;
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

export function commitContext(sha: string): CommitContext {
  return { webviewSection: 'commit', sha, preventDefaultContextMenuItems: true };
}

export interface RowEnv {
  width: number;
  selected: string | null;
  headSha: string | null;
  jira: Record<string, string>;
  pills: Map<string, RefPill[]>;
  isCi: (c: Commit) => boolean;
  /** Lower-cased search text; '' = no search. Non-matching rows are dimmed. */
  query: string;
  nowMs: number;
  wipCount: number;
}

export function rowMatches(c: Commit, q: string): boolean {
  return !q || c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q);
}

export function rowHtml(r: LaidRow, e: RowEnv): string {
  if (r.wip) {
    return `<div class="gr${e.selected === WIP_SHA ? ' on' : ''}" data-sha="${WIP_SHA}">${rowSvg(r, e.width, { head: false, ci: false })}`
      + `<div class="gdesc"><span class="wip">Uncommitted Changes (${e.wipCount})</span></div><div class="gwhen">*</div><div class="gwho">*</div><div class="gsha">*</div></div>`;
  }
  const c = r.commit as Commit;
  const cls = c.parents.length > 1 ? 'merge' : e.isCi(c) ? 'ci' : '';
  const ago = fmtAgo(minutesAgo(c.time, e.nowMs));
  return `<div class="gr${e.selected === c.sha ? ' on' : ''}${rowMatches(c, e.query) ? '' : ' dim'}" data-sha="${c.sha}" data-vscode-context="${esc(JSON.stringify(commitContext(c.sha)))}">`
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
  return `<div class="dh"><div class="row1">Commit <span class="sha">${c.sha}</span></div><h2>${subjectHtml(c.subject, e.jira, true)}</h2>`
    + `${c.body.trim() ? `<div class="body">${esc(c.body.trim())}</div>` : ''}</div>`
    + `<dl class="dmeta"><dt>Author</dt><dd title="${esc(c.email)}">${esc(c.author)}</dd><dt>Date</dt><dd title="${esc(when)}">${fmtAgoLong(mins)}</dd>`
    + `<dt>Parent${merge ? 's' : ''}</dt><dd>${parents}</dd>`
    + (pills?.length ? `<dt>Refs</dt><dd>${pillsHtml(pills, 0)}</dd>` : '')
    + (url ? `<dt>Jira</dt><dd><button class="jira" data-url="${esc(url)}">${esc(p.key)} ↗</button></dd>` : '')
    + `</dl><div class="dsec"><div class="dsec-h">${merge ? 'MERGE COMMIT' : 'FILES CHANGED'}<span class="n">${tot}</span></div>`
    + (merge ? `<div class="note">Joins <code>${c.parents[1].slice(0, 7)}</code> into <code>${c.parents[0].slice(0, 7)}</code>. The changes live in the merged commits.</div>` : '')
    + list + '</div>';
}

export function wipDetailsHtml(wip: Status, head: Head): string {
  const rows = [
    ...wip.staged.map((f, i) => fileRow(i, 'staged', f, ' · staged', f.path)),
    ...wip.unstaged.map((f, i) => fileRow(i, 'unstaged', f, f.untracked ? ' · untracked' : '', f.path)),
  ];
  const where = head.branch ?? (head.sha ? 'detached HEAD' : 'no commits yet');
  return `<div class="dh"><div class="row1">Working tree · ${esc(where)}</div><h2>Uncommitted Changes</h2></div>`
    + `<div class="note">Staging and committing happen in VS Code's built-in Source Control. Gitsprout only shows them here.<br>`
    + `<button class="vbtn" data-scm="1">Open Source Control</button></div>`
    + `<div class="dsec"><div class="dsec-h">FILES<span class="n">${rows.length}</span></div>${rows.join('')}</div>`;
}

export const noDetailsHtml = '<div class="nodetail">Select a commit to see its details</div>';

/** The picked file of the WIP list. */
export function wipFile(wip: Status, area: string, i: number): FileChange | undefined {
  return (area === 'staged' ? wip.staged : wip.unstaged)[i];
}
