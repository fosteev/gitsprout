// Graph UI entry point: DOM glue around the pure model (layout.ts, render.ts, format.ts).
import type { FileChange, FileStat } from '../src/git/types';
import type { DiffStyle, FromWebview, ToolbarAction, ToWebview, WorktreeAction } from '../src/graph/protocol';
import './base.css';
import './styles.css';
import './diff.css';
import './tokens.css';
import { branchOwners, childrenOf, containedIn, type Owner } from './branches';
import { applyDiffStyle } from './diffStyle';
import { ciMatcher } from './format';
import { languageFor } from './highlight';
import { graphWidth, isWorktreeWipSha, laneX, layout, RH, visibleRows, WIP_SHA, type LaidRow } from './layout';
import {
  branchTipHtml, canDiscard, commitDetailsHtml, diffBarHtml, diffBodyHtml, HEAD_PUSHED_NOTE, keepSet, NO_SUMMARY_ERROR, noDetailsHtml, primaryClass, primaryInnerHtml, refsBySha, rowHtml,
  SUMMARY_LIMIT, WIP_LABEL, wipBarHtml, worktreeCardHtml, wipCommitHtml, wipDirKeys, wipFile, wipFileCount, wipHeaderHtml, wipListsHtml, wipPrimary,
  type CommitCtx, type DiffBody, type DiffMode, type FilesState, type RefPill, type RowEnv, type WipDraft, type WipView,
} from './render';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; setState(s: unknown): void; getState?(): unknown };
const api = acquireVsCodeApi();
const send = (m: FromWebview): void => api.postMessage(m);

/** Height of the sticky column header (styles.css `.gcols`). */
const HEAD_H = 24;
const OVERSCAN = 12;

type State = Extract<ToWebview, { type: 'state' }>;

interface Model {
  rows: LaidRow[];
  width: number;
  pills: Map<string, RefPill[]>;
  hiddenN: number;
  ciTotal: number;
  isCi: (c: State['commits'][number]) => boolean;
  bySha: Map<string, State['commits'][number]>;
  /** shas of the shown commit rows (CI-hidden ones excluded) */
  known: Set<string>;
  indexOf: Map<string, number>;
  /** other worktrees' WIP rows by row id (`WIP:<path>`) → the worktree path */
  worktreeRows: Map<string, string>;
  /** the branch each commit was made on (inferred) and the child links behind "Also in", for the node hover card */
  owners: Map<string, Owner>;
  children: Map<string, string[]>;
}

let st: State | undefined;
let model: Model | undefined;
let selected: string | null = null;
let query = '';
let start = -1;
let end = -1;
/** A tree asked to reveal a sha the current model lacks (the tab was stale): applied on the next state. */
let pendingReveal: string | null = null;
let rafPending = false;
const files = new Map<string, FileStat[] | { error: string }>();

// WIP panel state. The draft, the Path/Tree view and the collapsed keys live in vscode's webview state (per tab = per repo).
const emptyDraft = (): WipDraft => ({ summary: '', description: '', amend: false });
let draft: WipDraft = emptyDraft();
let wipView: WipView = 'tree';
let collapsed = new Set<string>();
/** A WIP operation is running (extension's `wipBusy`): every WIP button is disabled. */
let wipBusy = false;
/**
 * A git action was sent and its `wipBusy` round-trip has not finished: guards double clicks and key repeat between the
 * click and the extension's `wipBusy`, and keeps the old rows inert until the `state` that follows the op.
 * 'sent' → waiting for wipBusy{on:true} (a 3 s fallback, in case the message was rejected); 'done' → op finished,
 * waiting for the next state (a 0.6 s fallback).
 */
let wipPending: 'sent' | 'done' | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
/** Inline error under the commit box (cleared on the next keystroke). */
let draftErr = '';
/** HEAD's message and pushed flag as the extension last reported them (`amendInfo`), valid while HEAD is still `sha`. */
let headInfo: { sha: string | null; summary: string; description: string; pushed: boolean } | null = null;
/** The HEAD sha we last asked `amendInfo` for (so a state message does not re-ask in a loop). */
let amendAsked: string | null | undefined;
/** The commit box is in the DOM: it is built once per WIP selection and only patched afterwards. */
let wipMounted = false;
/** The repo root the persisted state belongs to; a `state` for another root drops it. */
let stateRoot: string | undefined;
/** The inline diff that replaces the graph while open (null = the graph is shown). Not persisted; only `diffMode` is. */
interface OpenDiff {
  area: 'commit' | 'staged' | 'unstaged';
  /** the commit of a commit diff */
  sha: string;
  file: FileStat | FileChange;
  body: DiffBody;
}
let diff: OpenDiff | null = null;
let diffMode: DiffMode = 'inline';
/** Bumped per request (and on close); a `diff` answer with another `req` is stale. */
let diffReq = 0;
/** `#list` scrollTop at the moment the diff opened (a hidden element loses it). */
let listScroll = 0;
const PANE_MIN = 240, GRAPH_MIN = 240;
/** Details pane width the user dragged the sash to; null = the CSS default. Not tied to a repo. */
let paneWidth: number | null = null;
/** Unstaged share of the WIP lists' height (0..1) the user dragged the sash to; null = half. */
let listSplit: number | null = null;
/** The `Worktrees` toolbar chip: other worktrees' WIP rows and pills. On by default; persisted. */
let showWorktrees = true;

function restore(): void {
  const raw = api.getState?.();
  if (typeof raw !== 'object' || raw === null) return;
  const o = raw as { root?: unknown; draft?: unknown; view?: unknown; collapsed?: unknown; paneWidth?: unknown; listSplit?: unknown; diffMode?: unknown; worktrees?: unknown };
  if (typeof o.paneWidth === 'number' && o.paneWidth > 0) paneWidth = o.paneWidth;
  if (typeof o.listSplit === 'number' && o.listSplit > 0 && o.listSplit < 1) listSplit = o.listSplit;
  if (o.diffMode === 'inline' || o.diffMode === 'split') diffMode = o.diffMode;
  if (typeof o.worktrees === 'boolean') showWorktrees = o.worktrees;
  if (typeof o.root === 'string') stateRoot = o.root;
  const d = o.draft as Partial<WipDraft> | null | undefined;
  if (d && typeof d.summary === 'string' && typeof d.description === 'string' && typeof d.amend === 'boolean') {
    draft = { summary: d.summary, description: d.description, amend: d.amend };
  }
  if (o.view === 'path' || o.view === 'tree') wipView = o.view;
  if (Array.isArray(o.collapsed)) collapsed = new Set(o.collapsed.filter((k): k is string => typeof k === 'string'));
}
restore();

function persist(): void {
  if (stateRoot === undefined) return;
  api.setState({ root: stateRoot, draft, view: wipView, collapsed: [...collapsed], paneWidth, listSplit, diffMode, worktrees: showWorktrees });
}

/** Toolbar action buttons (GitKraken-style row); 16×16 stroke icons, `group` puts a separator between groups. */
const ACTIONS: { id: ToolbarAction; label: string; title: string; group: number; icon: string }[] = [
  { id: 'fetch', label: 'Fetch', title: 'Fetch', group: 0, icon: 'M4.5 10A3 3 0 0 1 4.6 4a3.6 3.6 0 0 1 6.9.7A2.6 2.6 0 0 1 11.5 10M8 7v7M5.8 11.8 8 14l2.2-2.2' },
  { id: 'pull', label: 'Pull', title: 'Pull', group: 0, icon: 'M8 2v9M4.5 7.5 8 11l3.5-3.5M3 14h10' },
  { id: 'push', label: 'Push', title: 'Push', group: 0, icon: 'M8 12V3M4.5 6.5 8 3l3.5 3.5M3 14h10' },
  { id: 'branch', label: 'Branch', title: 'Create Branch…', group: 1, icon: 'M5 4.5v7M11 6.5c0 3-6 1.8-6 5M6.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M12.5 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M6.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0' },
  { id: 'stash', label: 'Stash', title: 'Stash Changes…', group: 1, icon: 'M2 9v4.5h12V9M2 9h3l1 1.5h4L11 9h3M8 1.5v5.5M5.8 4.8 8 7l2.2-2.2' },
  { id: 'pop', label: 'Pop', title: 'Pop Latest Stash', group: 1, icon: 'M2 9v4.5h12V9M2 9h3l1 1.5h4L11 9h3M8 7V1.5M5.8 3.7 8 1.5l2.2 2.2' },
  { id: 'terminal', label: 'Terminal', title: 'Open Terminal in Repository', group: 2, icon: 'M3 4l4 4-4 4M8.5 12.5H13' },
];

const app = document.getElementById('app') as HTMLElement;
app.innerHTML = `
  <div class="wvbar">
    <button class="vchip" id="repo" title="Switch repository (⌥⌘R)"></button>
    <input id="q" class="vin" placeholder="Search commits, SHA, author" autocomplete="off" aria-label="Search commits">
    <button class="vchip" id="ci" aria-pressed="false"></button>
    <button class="vchip" id="wt" aria-pressed="true" title="Show other worktrees: their uncommitted changes and checked-out branches"></button>
    <span class="busy" id="busy" hidden>Loading…</span>
    <span class="cnt" id="cnt"></span>
    <div class="acts" role="toolbar" aria-label="Repository actions">${ACTIONS.map((a, i) =>
      `${i && ACTIONS[i - 1].group !== a.group ? '<span class="acts-sep"></span>' : ''}<button class="act" id="act-${a.id}" data-action="${a.id}" title="${a.title}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${a.icon}"/></svg><span class="lbl">${a.label}</span><span class="badge" hidden></span></button>`).join('')}</div>
    <button class="vchip" id="refresh" title="Refresh">Refresh</button>
    <button class="ib" id="settings" title="Gitsprout settings" aria-label="Gitsprout settings"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg></button>
  </div>
  <div class="msg" id="msg" hidden></div>
  <div class="split" id="split">
    <div class="glist" id="list" tabindex="0">
      <div class="gcols"><span>Graph</span><span>Description</span><span class="gwhen">Date</span><span class="gwho">Author</span><span class="gsha">Commit</span></div>
      <div id="rows"></div>
    </div>
    <div class="dview" id="dview" hidden><div class="dbar" id="dbar"></div><div class="dbody" id="dbody"></div></div>
    <div class="details" id="details"></div>
    <div class="sash" id="sash" title="Drag to resize, double-click to reset"></div>
  </div>`;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const list = $('list'), rowsEl = $('rows'), details = $('details'), qEl = $<HTMLInputElement>('q');

function build(s: State): Model {
  const isCiSubject = ciMatcher(s.settings.ciPattern);
  const isCi: Model['isCi'] = (c) => isCiSubject(c.subject);
  const pills = refsBySha(s.refs, s.head, showWorktrees ? s.worktrees : null);
  const keep = keepSet(pills, s.head);
  const otherWip = showWorktrees ? s.worktrees.filter((w) => !w.current && w.changes > 0 && w.head).map((w) => ({ path: w.path, head: w.head as string })) : [];
  const vr = visibleRows(s.commits, { hideCi: s.settings.hideCi, isCi, keep, headSha: s.head.sha, dirty: s.wip !== null, otherWip });
  const lay = layout(vr.rows);
  return {
    rows: lay.rows, width: graphWidth(lay.max), pills, hiddenN: vr.hiddenN,
    ciTotal: s.commits.filter(isCi).length, isCi,
    bySha: new Map(s.commits.map((c) => [c.sha, c])),
    known: new Set(lay.rows.filter((r) => !r.wip).map((r) => r.sha)),
    indexOf: new Map(lay.rows.map((r, i) => [r.sha, i])),
    worktreeRows: new Map(lay.rows.flatMap((r) => (r.worktree !== undefined ? [[r.sha, r.worktree] as [string, string]] : []))),
    owners: branchOwners(s.commits, s.refs, s.head),
    children: childrenOf(s.commits),
  };
}

function rowEnv(s: State, m: Model): RowEnv {
  return {
    root: s.repo.root, width: m.width, selected, headSha: s.head.sha, jira: s.settings.jira, pills: m.pills, isCi: m.isCi,
    query: query.trim().toLowerCase(), nowMs: Date.now(), wipCount: s.wip ? wipFileCount(s.wip) : 0, wipSummary: draft.summary,
    worktrees: s.worktrees,
  };
}

function renderRows(force = false): void {
  if (!st || !model) { rowsEl.innerHTML = ''; start = end = -1; return; }
  const n = model.rows.length;
  const top = Math.max(0, list.scrollTop - HEAD_H);
  const s = Math.max(0, Math.floor(top / RH) - OVERSCAN);
  const e = Math.min(n, Math.ceil((top + list.clientHeight) / RH) + OVERSCAN);
  if (!force && s === start && e === end) return;
  start = s; end = e;
  const env = rowEnv(st, model);
  list.style.setProperty('--gw', `${model.width}px`);
  rowsEl.style.paddingTop = `${s * RH}px`;
  rowsEl.style.paddingBottom = `${(n - e) * RH}px`;
  rowsEl.innerHTML = model.rows.slice(s, e).map((r) => rowHtml(r, env)).join('');
}

function setWipLayout(on: boolean): void {
  $('split').classList.toggle('wipon', on);
  details.classList.toggle('wipon', on);
  if (!on) wipMounted = false;
}

/** Acts that only change the view; the rest talk to git and wait while an operation runs. */
const UI_ACTS = new Set(['sec', 'dir', 'view', 'collapse', 'menu']);

const headInfoValid = (): boolean => !!st && headInfo !== null && headInfo.sha === st.head.sha;

function commitCtx(): CommitCtx {
  return {
    staged: st?.wip?.staged.length ?? 0, unborn: !!st && st.head.sha === null, busy: wipBusy,
    headPushed: headInfoValid() && !!headInfo?.pushed, error: draftErr,
  };
}

/** WIP selected: header and lists are rebuilt on every call; the commit box is built once and patched. */
function renderWip(s: State, wip: NonNullable<State['wip']>): void {
  if (!wipMounted) {
    details.innerHTML = '<div class="wp"><div id="wip-head"></div><div class="wpl" id="wip-lists"></div><div id="wip-commit"></div></div>';
    applyListSplit();
    $('wip-commit').innerHTML = wipCommitHtml(draft, commitCtx());
    wipMounted = true;
    // properties, not attributes: a leading newline or odd characters round-trip exactly
    $<HTMLInputElement>('wsum').value = draft.summary;
    $<HTMLTextAreaElement>('wdesc').value = draft.description;
  }
  renderWipLists(s, wip);
  patchCommit();
}

function renderWipLists(s: State, wip: NonNullable<State['wip']>): void {
  const keys = wipDirKeys(wip);
  const where = s.head.branch ?? (s.head.sha ? 'detached HEAD' : 'no commits yet');
  $('wip-head').innerHTML = wipHeaderHtml(wipFileCount(wip), where) + wipBarHtml(wipView, keys.length > 0, keys.some((k) => !collapsed.has(k)));
  // each list scrolls on its own and is rebuilt here: keep where the user was
  const lists = $('wip-lists');
  const scroll = new Map([...lists.querySelectorAll<HTMLElement>('.wps')].map((el) => [el.dataset.area, el.querySelector('.wpb')?.scrollTop ?? 0]));
  lists.innerHTML = wipListsHtml(wip, wipView, collapsed, s.repo.root);
  for (const el of lists.querySelectorAll<HTMLElement>('.wps')) {
    const b = el.querySelector<HTMLElement>('.wpb');
    if (b) b.scrollTop = scroll.get(el.dataset.area) ?? 0;
  }
  // CSP forbids style attributes in markup; CSSOM is fine
  for (const el of details.querySelectorAll<HTMLElement>('[data-d]')) el.style.setProperty('--d', el.dataset.d as string);
  applyBusy();
  markDiffRow();
}

/** Updates the parts of the commit box that depend on state, never the inputs themselves. */
function patchCommit(): void {
  if (!wipMounted || !st?.wip) return;
  const ctx = commitCtx();
  const p = wipPrimary(draft.amend, ctx.staged);
  const left = SUMMARY_LIMIT - draft.summary.length;
  const cnt = $('wcnt');
  cnt.textContent = String(left);
  cnt.classList.toggle('over', left < 0);
  $('wbox').classList.toggle('bad', ctx.error !== '');
  const err = $('werr');
  err.hidden = ctx.error === '';
  err.textContent = ctx.error;
  const amend = $<HTMLInputElement>('wamend');
  amend.checked = draft.amend;
  const note = $('wamendnote');
  note.hidden = !(draft.amend && ctx.headPushed);
  note.textContent = HEAD_PUSHED_NOTE;
  const main = $('wprimary');
  main.className = primaryClass(p);
  main.innerHTML = primaryInnerHtml(p);
  $('wmore').hidden = !p.menu;
  if (!p.menu) $('wmenu').hidden = true;
  applyBusy();
}

function setPending(p: 'sent' | 'done' | null, ms = 0): void {
  wipPending = p;
  clearTimeout(pendingTimer);
  pendingTimer = p ? setTimeout(() => { wipPending = null; applyBusy(); }, ms) : undefined;
  applyBusy();
}

/** Sends a git-running WIP message and blocks further ones until the op's round-trip is over. */
function sendWip(m: FromWebview): void {
  send(m);
  setPending('sent', 3000);
}

const gitBlocked = (): boolean => wipBusy || wipPending !== null;

function applyBusy(): void {
  if (!wipMounted) return;
  // view-only buttons (Path/Tree, Collapse All) stay usable; the ▾ menu only holds git actions
  for (const b of details.querySelectorAll<HTMLButtonElement>('button')) b.disabled = gitBlocked() && (b.id === 'wmore' || !UI_ACTS.has(b.dataset.act ?? ''));
  const amend = document.getElementById('wamend') as HTMLInputElement | null;
  if (amend) amend.disabled = wipBusy || !st || st.head.sha === null;
  if (gitBlocked()) { const m = document.getElementById('wmenu'); if (m) m.hidden = true; }
}

/** Live label of the graph's WIP row while typing (the rows are virtual; the next render reads the draft too). */
function syncWipRow(): void {
  const el = rowsEl.querySelector('.gr[data-sha="WIP"] .wip');
  if (el) el.textContent = draft.summary.trim() || WIP_LABEL;
}

function renderDetails(): void {
  renderDetailsInner();
  markDiffRow();
}

function renderDetailsInner(): void {
  if (!st || !model) { setWipLayout(false); details.innerHTML = noDetailsHtml; return; }
  if (selected === WIP_SHA && st.wip) { setWipLayout(true); renderWip(st, st.wip); return; }
  const wtPath = selected ? model.worktreeRows.get(selected) : undefined;
  if (wtPath !== undefined) {
    setWipLayout(false);
    const w = st.worktrees.find((x) => x.path === wtPath);
    details.innerHTML = w ? worktreeCardHtml(w) : noDetailsHtml;
    return;
  }
  setWipLayout(false);
  const c = selected ? model.bySha.get(selected) : undefined;
  if (!c) { details.innerHTML = noDetailsHtml; return; }
  const f = files.get(c.sha);
  const fs: FilesState = f === undefined ? 'loading' : f;
  details.innerHTML = commitDetailsHtml(c, fs, { jira: st.settings.jira, pills: model.pills, nowMs: Date.now(), known: model.known });
}

// ---- Inline diff ----

/** The file rows of the details pane in DOM order (across areas): what prev/next walk. */
const diffRows = (): HTMLElement[] => [...details.querySelectorAll<HTMLElement>('.tr[data-file]')].filter((r) => r.dataset.area !== undefined);

/** The `FileStat` / `FileChange` a details row stands for. */
function rowFile(row: HTMLElement): { area: OpenDiff['area']; file: FileStat | FileChange } | undefined {
  const i = Number(row.dataset.file);
  const area = row.dataset.area;
  if (area === 'commit') {
    const f = selected ? files.get(selected) : undefined;
    return Array.isArray(f) && f[i] ? { area, file: f[i] } : undefined;
  }
  if ((area === 'staged' || area === 'unstaged') && st?.wip) {
    const file = wipFile(st.wip, area, i);
    return file ? { area, file } : undefined;
  }
  return undefined;
}

const sameFile = (a: { path: string; origPath: string | null }, b: { path: string; origPath: string | null }): boolean => a.path === b.path && a.origPath === b.origPath;

/** Highlights the open file's row (the details pane is re-rendered often) and refreshes the bar's prev/next state. */
function markDiffRow(): void {
  if (!diff) return;
  const open = diff;
  const rows = diffRows();
  let at = -1;
  rows.forEach((r, i) => {
    const f = rowFile(r);
    const hit = !!f && f.area === open.area && sameFile(f.file, open.file);
    r.classList.toggle('on', hit);
    if (hit) at = i;
  });
  renderDiffBar(at > 0, at >= 0 && at < rows.length - 1);
}

function diffLabel(d: OpenDiff): string {
  if (d.area === 'commit') {
    const parent = model?.bySha.get(d.sha)?.parents[0];
    return `${parent ? parent.slice(0, 7) : 'empty'} ↔ ${d.sha.slice(0, 7)}`;
  }
  if (d.area === 'staged') return 'Staged';
  return (d.file as FileChange).untracked ? 'Untracked' : 'Working Tree';
}

function renderDiffBar(hasPrev: boolean, hasNext: boolean): void {
  if (!diff) return;
  $('dbar').innerHTML = diffBarHtml({
    status: diff.file.status, path: diff.file.path, origPath: diff.file.origPath, label: diffLabel(diff), mode: diffMode, hasPrev, hasNext,
  });
}

/** `gitsprout.diff.*` as last sent by the host; until the first `diffStyle` the diff is plain text. */
let diffStyle: DiffStyle | undefined;
/** Rendered diff bodies per patch object, keyed by language and mode: highlighting is not repeated on re-renders. */
const bodyHtmlMemo = new WeakMap<object, Map<string, string>>();

function diffBodyFor(d: OpenDiff): string {
  const lang = diffStyle?.highlight ? languageFor(d.file.path) : null;
  if (typeof d.body === 'string') return diffBodyHtml(d.body, diffMode, lang);
  let byKey = bodyHtmlMemo.get(d.body);
  if (!byKey) bodyHtmlMemo.set(d.body, byKey = new Map());
  const key = `${lang ?? ''}|${diffMode}`;
  let html = byKey.get(key);
  if (html === undefined) byKey.set(key, html = diffBodyHtml(d.body, diffMode, lang));
  return html;
}

function renderDiffBody(keepScroll = false): void {
  if (!diff) return;
  const body = $('dbody');
  const top = body.scrollTop;
  body.innerHTML = diffBodyFor(diff);
  body.scrollTop = keepScroll ? top : 0;
}

function requestDiff(): void {
  if (!diff) return;
  const req = ++diffReq;
  if (diff.area === 'commit') send({ type: 'diffCommitFile', req, sha: diff.sha, file: diff.file as FileStat });
  else send({ type: 'diffWipFile', req, file: diff.file as FileChange, area: diff.area });
}

/** Opens the diff of a details row, or switches the open one to it. */
function openDiff(area: OpenDiff['area'], file: FileStat | FileChange): void {
  if (!diff) {
    listScroll = list.scrollTop;
    list.hidden = true;
    $('dview').hidden = false;
  }
  diff = { area, sha: selected ?? '', file, body: 'loading' };
  renderDiffBody();
  markDiffRow();
  requestDiff();
}

function closeDiff(): void {
  if (!diff) return;
  diff = null;
  diffReq++; // an answer still in flight is stale now
  $('dview').hidden = true;
  list.hidden = false;
  list.scrollTop = listScroll;
  for (const r of details.querySelectorAll('.tr.on')) r.classList.remove('on');
  renderRows(true);
  list.focus();
}

function stepDiff(dir: 1 | -1): void {
  if (!diff) return;
  const rows = diffRows();
  const at = rows.findIndex((r) => r.classList.contains('on'));
  const next = rows[at + dir];
  if (at < 0 || !next) return;
  const t = rowFile(next);
  if (t) openDiff(t.area, t.file);
}

function onDiff(m: Extract<ToWebview, { type: 'diff' }>): void {
  if (!diff || m.req !== diffReq) return;
  diff.body = 'error' in m ? { error: m.error } : m.patch;
  renderDiffBody(true);
}

/** A `state` arrived: a WIP diff follows its file (same path in its area, else the other area, else it closes). */
function followDiff(s: State): void {
  if (!diff) return;
  if (diff.area === 'commit') {
    if (selected !== diff.sha) closeDiff();
    return;
  }
  if (!s.wip || selected !== WIP_SHA) { closeDiff(); return; }
  const other = diff.area === 'staged' ? 'unstaged' : 'staged';
  for (const area of [diff.area, other] as const) {
    const f = s.wip[area].find((x) => sameFile(x, diff!.file));
    if (!f) continue;
    const moved = area !== diff.area;
    diff.area = area;
    diff.file = f;
    if (moved) { diff.body = 'loading'; renderDiffBody(); } // another side of the file: start over
    requestDiff(); // silent: the old content stays (and its scroll position) until the answer
    return;
  }
  closeDiff();
}

$('dview').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-dact]');
  if (!b || b.disabled || !diff) return;
  switch (b.dataset.dact) {
    case 'close': closeDiff(); break;
    case 'prev': stepDiff(-1); break;
    case 'next': stepDiff(1); break;
    case 'mode':
      diffMode = diffMode === 'split' ? 'inline' : 'split';
      persist();
      markDiffRow();
      renderDiffBody(true);
      break;
    case 'editor':
      if (diff.area === 'commit') send({ type: 'openCommitFile', sha: diff.sha, file: diff.file as FileStat });
      else send({ type: 'openWipFile', file: diff.file as FileChange, area: diff.area });
      break;
  }
});

function renderToolbar(): void {
  if (!st || !model) return;
  $('repo').textContent = `${st.repo.name} ▾`;
  // One repo in the window: nothing to switch to, so the chip is hidden (the tab title still names the repo).
  $('repo').hidden = !st.multiRepo;
  const ci = $('ci');
  const label = st.settings.ciPattern === '^AutoBuild$' ? 'AutoBuild' : 'CI';
  ci.textContent = `Hide ${label} · ${st.settings.hideCi ? `${model.hiddenN} hidden` : model.ciTotal}`;
  ci.setAttribute('aria-pressed', String(st.settings.hideCi));
  // Nothing to show or hide in a repo with a single worktree.
  const others = st.worktrees.filter((w) => !w.current);
  const wt = $('wt');
  wt.hidden = others.length === 0;
  wt.textContent = `Worktrees · ${others.length}`;
  wt.setAttribute('aria-pressed', String(showWorktrees));
  const n = st.commits.length - (st.settings.hideCi ? model.hiddenN : 0);
  $('cnt').textContent = `${n}${st.commits.length >= st.settings.logLimit ? '+' : ''} commits`;
  const head = st.head.branch ? st.refs.locals.find((b) => b.name === st!.head.branch) : undefined;
  setBadge('pull', head?.behind ?? 0, 'behind');
  setBadge('push', head?.ahead ?? 0, 'ahead');
  ($('act-pop') as HTMLButtonElement).disabled = st.stashes === 0;
  $('act-pop').title = st.stashes ? `Pop Latest Stash (${st.stashes} stash${st.stashes === 1 ? '' : 'es'})` : 'No stashes';
}

function setBadge(id: ToolbarAction, n: number, what: string): void {
  const b = $(`act-${id}`).querySelector('.badge') as HTMLElement;
  b.hidden = n === 0;
  b.textContent = String(n);
  b.title = `${n} commit${n === 1 ? '' : 's'} ${what}`;
}

function scrollToRow(sha: string, center: boolean): void {
  const i = model?.indexOf.get(sha);
  if (i === undefined) return;
  const rowTop = HEAD_H + i * RH;
  const h = list.clientHeight;
  if (center) list.scrollTop = Math.max(0, rowTop - (h - RH) / 2);
  else if (rowTop < list.scrollTop + HEAD_H) list.scrollTop = rowTop - HEAD_H;
  else if (rowTop + RH > list.scrollTop + h) list.scrollTop = rowTop + RH - h;
}

function select(sha: string, o: { center?: boolean } = {}): void {
  const changed = sha !== selected;
  if (changed) closeDiff();
  selected = sha;
  scrollToRow(sha, !!o.center);
  renderRows(true);
  if (changed) details.scrollTop = 0;
  renderDetails();
  if (changed && sha !== WIP_SHA && !files.has(sha) && model?.bySha.has(sha)) send({ type: 'select', sha });
}

function defaultSelection(): string | null {
  if (!st || !model) return null;
  if (selected && ((selected === WIP_SHA && st.wip) || model.known.has(selected) || model.worktreeRows.has(selected))) return selected;
  if (st.head.sha && model.bySha.has(st.head.sha)) return st.head.sha;
  return model.rows.find((r) => !r.wip)?.sha ?? model.rows[0]?.sha ?? null;
}

function showMessage(text: string | null): void {
  const m = $('msg');
  m.hidden = text === null;
  m.textContent = text ?? '';
  $('split').hidden = text !== null;
}

function onState(s: State): void {
  if (st && st.repo.root !== s.repo.root) { closeDiff(); files.clear(); selected = null; list.scrollTop = 0; }
  if (stateRoot !== undefined && stateRoot !== s.repo.root) {
    // the persisted draft belongs to another repo
    draft = emptyDraft(); wipView = 'tree'; collapsed = new Set(); draftErr = ''; headInfo = null; amendAsked = undefined; wipMounted = false;
  }
  stateRoot = s.repo.root;
  if (wipPending === 'done') setPending(null);
  // HEAD became unborn (e.g. `checkout --orphan`) under a draft with Amend on: there is nothing to amend
  if (s.head.sha === null && draft.amend) { draft.amend = false; headInfo = null; }
  if (files.size > 500) files.clear();
  st = s;
  model = build(s);
  hideTip();
  showMessage(null);
  renderToolbar();
  const want = pendingReveal;
  pendingReveal = null;
  if (want && model.known.has(want)) selected = want;
  const sel = defaultSelection();
  selected = sel;
  followDiff(s);
  if (want && sel === want) scrollToRow(want, true);
  renderRows(true);
  renderDetails();
  // Ask for the files of a commit we have none for (first state, or the selection moved to a new commit).
  if (sel && sel !== WIP_SHA && !files.has(sel) && model.bySha.has(sel)) send({ type: 'select', sha: sel });
  // A restored draft with Amend on has no HEAD info yet (it is not persisted): ask once per HEAD.
  if (draft.amend && s.head.sha !== null && !headInfoValid() && amendAsked !== s.head.sha) { amendAsked = s.head.sha; send({ type: 'amendInfo' }); }
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'state':
      onState(m);
      persist(); // `root` is what the serializer uses to re-bind the tab to this repo after a window reload
      break;
    case 'details':
      files.set(m.sha, m.error !== undefined ? { error: m.error } : m.files);
      if (m.sha === selected) renderDetails();
      break;
    case 'diff': onDiff(m); break;
    case 'diffStyle':
      diffStyle = m.style;
      applyDiffStyle(m.style);
      renderDiffBody(true);
      break;
    case 'reveal':
      closeDiff();
      if (model?.known.has(m.sha)) select(m.sha, { center: true });
      else pendingReveal = m.sha;
      break;
    case 'busy': $('busy').hidden = !m.on; break;
    case 'wipBusy':
      wipBusy = m.on;
      if (m.on) setPending(null);
      else setPending('done', 600);
      break;
    case 'committed': onCommitted(); break;
    case 'amendInfo': onAmendInfo(m); break;
    case 'error': closeDiff(); st = undefined; model = undefined; selected = null; renderRows(); renderDetails(); showMessage(m.message); break;
  }
});

// Rows.
rowsEl.addEventListener('click', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.gr');
  if (!row?.dataset.sha) return;
  select(row.dataset.sha);
  list.focus();
});

// Hover card on a graph node: which branch the commit was made on. Shown after a short rest on the row's graph cell.
const tip = document.createElement('div');
tip.className = 'btip';
tip.hidden = true;
document.body.append(tip);
let tipSha: string | null = null;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
const TIP_DELAY = 350;
function hideTip(): void {
  clearTimeout(tipTimer);
  tipSha = null;
  tip.hidden = true;
}
function showTip(row: HTMLElement, sha: string): void {
  if (!st || !model) return;
  const r = model.rows[model.indexOf.get(sha) ?? -1];
  if (!r || r.wip) return;
  tip.innerHTML = branchTipHtml(model.owners.get(sha), r.col, containedIn(sha, model.children, st.refs));
  tip.hidden = false;
  const box = row.getBoundingClientRect();
  const x = Math.min((row.firstElementChild ?? row).getBoundingClientRect().left + laneX(r.col) - 10, window.innerWidth - tip.offsetWidth - 8);
  const below = box.bottom + 4 + tip.offsetHeight <= window.innerHeight;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${below ? box.bottom + 4 : box.top - 4 - tip.offsetHeight}px`;
}
rowsEl.addEventListener('mouseover', (ev) => {
  const cell = (ev.target as Element).closest('.gr > svg');
  const row = cell?.parentElement;
  const sha = row?.dataset.sha;
  if (!row || !sha || sha === WIP_SHA || isWorktreeWipSha(sha)) { hideTip(); return; }
  if (sha === tipSha) return;
  clearTimeout(tipTimer);
  tipSha = sha;
  // a card already open moves to the next node at once, like VS Code hovers
  if (!tip.hidden) showTip(row, sha);
  else tipTimer = setTimeout(() => { if (tipSha === sha && row.isConnected) showTip(row, sha); }, TIP_DELAY);
});
rowsEl.addEventListener('mouseleave', hideTip);
rowsEl.addEventListener('mousedown', hideTip);
list.addEventListener('scroll', () => {
  hideTip();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderRows(); });
}, { passive: true });
new ResizeObserver(() => renderRows()).observe(list);

// Sash between the graph and the details pane. The width lives in `--dw`; CSS clamps it to the split.
const split = $('split'), sash = $('sash');
const applyPaneWidth = (): void => {
  if (paneWidth === null) split.style.removeProperty('--dw'); else split.style.setProperty('--dw', `${paneWidth}px`);
};
applyPaneWidth();
sash.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  sash.setPointerCapture(ev.pointerId);
  sash.classList.add('on');
  const right = split.getBoundingClientRect().right;
  const move = (e: PointerEvent): void => {
    paneWidth = Math.round(Math.min(Math.max(right - e.clientX, PANE_MIN), split.clientWidth - GRAPH_MIN));
    applyPaneWidth();
  };
  const up = (): void => {
    sash.removeEventListener('pointermove', move);
    sash.classList.remove('on');
    persist();
  };
  sash.addEventListener('pointermove', move);
  sash.addEventListener('pointerup', up, { once: true });
  sash.addEventListener('pointercancel', up, { once: true });
});
sash.addEventListener('dblclick', () => { paneWidth = null; applyPaneWidth(); persist(); });

// Sash between the Unstaged and Staged lists (rebuilt with the lists, so listen on window while dragging).
const LIST_MIN = 52;
function applyListSplit(): void {
  const el = document.getElementById('wip-lists');
  if (!el) return;
  if (listSplit === null) el.style.removeProperty('--uf'); else el.style.setProperty('--uf', String(listSplit));
}
details.addEventListener('pointerdown', (ev) => {
  const h = (ev.target as HTMLElement).closest<HTMLElement>('.hsash');
  if (!h || ev.button !== 0) return;
  ev.preventDefault();
  const lists = $('wip-lists');
  h.classList.add('on');
  const move = (e: PointerEvent): void => {
    const r = lists.getBoundingClientRect();
    if (r.height <= LIST_MIN * 2) return;
    const y = Math.min(Math.max(e.clientY - r.top, LIST_MIN), r.height - LIST_MIN);
    listSplit = Math.round((y / r.height) * 1000) / 1000;
    applyListSplit();
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    lists.querySelector('.hsash')?.classList.remove('on');
    persist();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});
details.addEventListener('dblclick', (ev) => {
  if (!(ev.target as HTMLElement).closest('.hsash')) return;
  listSplit = null; applyListSplit(); persist();
});

// Details card.
details.addEventListener('click', (ev) => {
  if (!st) return;
  const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (a && wipMounted) { onWipAct(a); return; }
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-url],[data-select],[data-file],[data-copy],[data-wt]');
  if (!t) return;
  if (t.dataset.wt) send({ type: 'worktree', action: t.dataset.wt as WorktreeAction, path: t.dataset.path ?? '' });
  else if (t.dataset.copy) send({ type: 'copy', text: t.dataset.copy });
  else if (t.dataset.url) send({ type: 'openUrl', url: t.dataset.url });
  else if (t.dataset.select) { if (model?.known.has(t.dataset.select)) select(t.dataset.select, { center: true }); }
  else if (t.dataset.file !== undefined) {
    const target = rowFile(t);
    if (target) openDiff(target.area, target.file);
  }
});

// WIP panel.

function onWipAct(el: HTMLElement): void {
  const act = el.dataset.act as string;
  const wip = st?.wip;
  if (!wip || (gitBlocked() && !UI_ACTS.has(act))) return;
  const file = el.dataset.file !== undefined && (el.dataset.area === 'staged' || el.dataset.area === 'unstaged')
    ? wipFile(wip, el.dataset.area, Number(el.dataset.file)) : undefined;
  switch (act) {
    case 'stage': if (file) sendWip({ type: 'stage', files: [file] }); break;
    case 'unstage': if (file) sendWip({ type: 'unstage', files: [file] }); break;
    case 'discard': if (file && canDiscard(file)) sendWip({ type: 'discard', file }); break;
    case 'stageAll': sendWip({ type: 'stageAll' }); break;
    case 'unstageAll': sendWip({ type: 'unstageAll' }); break;
    case 'discardAll': sendWip({ type: 'discardAll' }); break;
    case 'refresh': send({ type: 'refresh' }); break;
    case 'sec': case 'dir': {
      const key = el.dataset.key as string;
      if (!collapsed.delete(key)) collapsed.add(key);
      persist();
      renderWipLists(st as State, wip);
      break;
    }
    case 'view':
      wipView = el.dataset.view === 'path' ? 'path' : 'tree';
      persist();
      renderWipLists(st as State, wip);
      break;
    case 'collapse': {
      const keys = wipDirKeys(wip);
      if (keys.some((k) => !collapsed.has(k))) keys.forEach((k) => collapsed.add(k)); else keys.forEach((k) => collapsed.delete(k));
      persist();
      renderWipLists(st as State, wip);
      break;
    }
    case 'primary':
      if (wipPrimary(draft.amend, wip.staged.length).kind === 'stage') sendWip({ type: 'stageAll' });
      else commitAction(false);
      break;
    case 'menu': $('wmenu').hidden = !$('wmenu').hidden; break;
    case 'commit': $('wmenu').hidden = true; commitAction(false); break;
    case 'commitPush': $('wmenu').hidden = true; commitAction(true); break;
  }
}

/** Commit (or Commit and Push). Nothing staged and not amending → stage everything first, like the prototype. */
function commitAction(push: boolean): void {
  const wip = st?.wip;
  if (!wip || gitBlocked()) return;
  if (!draft.summary.trim()) {
    draftErr = NO_SUMMARY_ERROR;
    patchCommit();
    document.getElementById('wsum')?.focus();
    return;
  }
  if (!draft.amend && wip.staged.length === 0) { sendWip({ type: 'stageAll' }); return; }
  sendWip({ type: 'commit', summary: draft.summary, description: draft.description, amend: draft.amend, push: push && !draft.amend });
}

function onCommitted(): void {
  draft = emptyDraft();
  draftErr = '';
  headInfo = null;
  amendAsked = undefined;
  if (wipMounted) {
    $<HTMLInputElement>('wsum').value = '';
    $<HTMLTextAreaElement>('wdesc').value = '';
  }
  patchCommit();
  syncWipRow();
  persist();
}

function onAmendInfo(m: Extract<ToWebview, { type: 'amendInfo' }>): void {
  if ('unborn' in m) { draft.amend = false; headInfo = null; patchCommit(); persist(); return; }
  headInfo = { sha: st?.head.sha ?? null, summary: m.summary, description: m.description, pushed: m.pushed };
  // prefill only a still-empty draft, and only while Amend is still on
  if (draft.amend && !draft.summary.trim() && !draft.description.trim()) {
    draft.summary = m.summary;
    draft.description = m.description;
    if (wipMounted) {
      $<HTMLInputElement>('wsum').value = draft.summary;
      $<HTMLTextAreaElement>('wdesc').value = draft.description;
    }
    syncWipRow();
  }
  patchCommit();
  persist();
}

function onAmendToggle(on: boolean): void {
  draft.amend = on;
  draftErr = '';
  if (on) {
    amendAsked = st?.head.sha;
    send({ type: 'amendInfo' });
  } else if (headInfoValid() && headInfo && draft.summary === headInfo.summary && draft.description === headInfo.description) {
    // still HEAD's own message: drop the prefill
    draft.summary = '';
    draft.description = '';
    $<HTMLInputElement>('wsum').value = '';
    $<HTMLTextAreaElement>('wdesc').value = '';
    syncWipRow();
  }
  patchCommit();
  persist();
}

details.addEventListener('input', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'wsum') {
    draft.summary = (t as HTMLInputElement).value;
    draftErr = '';
    syncWipRow();
    patchCommit();
    persist();
  } else if (t.id === 'wdesc') {
    draft.description = (t as HTMLTextAreaElement).value;
    persist();
  }
});
details.addEventListener('change', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'wamend') onAmendToggle((t as HTMLInputElement).checked);
});
details.addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLElement;
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && (t.id === 'wsum' || t.id === 'wdesc')) {
    ev.preventDefault();
    // an IME composition owns Enter; a held key must not fire several commits
    if (!ev.isComposing && ev.keyCode !== 229 && !ev.repeat) commitAction(false);
  }
  else if (ev.key === 'Escape' && wipMounted && !$('wmenu').hidden) { $('wmenu').hidden = true; document.getElementById('wmore')?.focus(); }
});
// Close the Commit ▾ menu on a click anywhere else.
document.addEventListener('click', (ev) => {
  const m = document.getElementById('wmenu');
  if (m && !m.hidden && !(ev.target as HTMLElement).closest('#wmenu, #wmore')) m.hidden = true;
});

// Toolbar.
$('repo').addEventListener('click', () => send({ type: 'switchRepo' }));
$('refresh').addEventListener('click', () => send({ type: 'refresh' }));
$('settings').addEventListener('click', () => send({ type: 'openSettings' }));
for (const a of ACTIONS) $(`act-${a.id}`).addEventListener('click', () => send({ type: 'action', action: a.id }));
$('ci').addEventListener('click', () => {
  if (!st) return;
  st.settings.hideCi = !st.settings.hideCi;
  model = build(st);
  renderToolbar();
  // the selection may have just been hidden: fall back to HEAD / first row
  const sel = defaultSelection();
  if (sel !== null && sel !== selected) select(sel);
  else { selected = sel; renderRows(true); renderDetails(); }
  send({ type: 'toggleCi', hideCi: st.settings.hideCi });
});
$('wt').addEventListener('click', () => {
  if (!st) return;
  showWorktrees = !showWorktrees;
  persist();
  model = build(st);
  renderToolbar();
  // a hidden worktree row can't stay selected
  const sel = defaultSelection();
  if (sel !== null && sel !== selected) select(sel);
  else { selected = sel; renderRows(true); renderDetails(); }
});
qEl.addEventListener('input', () => { closeDiff(); query = qEl.value; renderRows(true); });
qEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { closeDiff(); jumpToMatch(ev.shiftKey ? -1 : 1); }
  else if (ev.key === 'Escape') { qEl.value = ''; query = ''; renderRows(true); }
});

function jumpToMatch(dir: 1 | -1): void {
  const q = query.trim().toLowerCase();
  if (!q || !model) return;
  const n = model.rows.length;
  const from = selected ? (model.indexOf.get(selected) ?? -1) : -1;
  for (let k = 1; k <= n; k++) {
    const r = model.rows[(((from + dir * k) % n) + n) % n];
    const c = r.commit;
    if (c && (c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q))) { select(r.sha, { center: true }); return; }
  }
}

// Keyboard: ↑/↓ and j/k move the selection.
document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = (ev.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (diff) {
    // ↑/↓ are left to the native scroll of the diff
    if (ev.key === 'Escape') { if (!(ev.target as HTMLElement).closest('#wmenu, #wmore')) { ev.preventDefault(); closeDiff(); } }
    else if (ev.key === 'j' || ev.key === 'k') { ev.preventDefault(); stepDiff(ev.key === 'j' ? 1 : -1); }
    return;
  }
  const dir = ev.key === 'ArrowDown' || ev.key === 'j' ? 1 : ev.key === 'ArrowUp' || ev.key === 'k' ? -1 : 0;
  if (!dir || !model?.rows.length) return;
  ev.preventDefault();
  const i = selected ? model.indexOf.get(selected) : undefined;
  const next = i === undefined ? (dir > 0 ? 0 : model.rows.length - 1) : Math.min(model.rows.length - 1, Math.max(0, i + dir));
  select(model.rows[next].sha);
});

renderDetails();
send({ type: 'ready' });
