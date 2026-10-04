// Graph UI entry point: DOM glue around the pure model (layout.ts, render.ts, format.ts).
import type { FileStat } from '../src/git/types';
import type { FromWebview, ToWebview } from '../src/graph/protocol';
import './styles.css';
import { ciMatcher } from './format';
import { graphWidth, layout, RH, visibleRows, WIP_SHA, type LaidRow } from './layout';
import {
  commitDetailsHtml, keepSet, noDetailsHtml, refsBySha, rowHtml, wipDetailsHtml, wipFile,
  type FilesState, type RefPill, type RowEnv,
} from './render';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void };
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

const app = document.getElementById('app') as HTMLElement;
app.innerHTML = `
  <div class="wvbar">
    <button class="vchip" id="repo" title="Switch repository (⌥⌘R)"></button>
    <input id="q" class="vin" placeholder="Search commits, SHA, author" autocomplete="off" aria-label="Search commits">
    <button class="vchip" id="ci" aria-pressed="false"></button>
    <span class="busy" id="busy" hidden>Loading…</span>
    <span class="cnt" id="cnt"></span>
    <button class="vchip" id="refresh" title="Refresh">Refresh</button>
  </div>
  <div class="msg" id="msg" hidden></div>
  <div class="split" id="split">
    <div class="glist" id="list" tabindex="0">
      <div class="gcols"><span>Graph</span><span>Description</span><span class="gwhen">Date</span><span class="gwho">Author</span><span class="gsha">Commit</span></div>
      <div id="rows"></div>
    </div>
    <div class="details" id="details"></div>
  </div>`;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const list = $('list'), rowsEl = $('rows'), details = $('details'), qEl = $<HTMLInputElement>('q');

function build(s: State): Model {
  const isCiSubject = ciMatcher(s.settings.ciPattern);
  const isCi: Model['isCi'] = (c) => isCiSubject(c.subject);
  const pills = refsBySha(s.refs, s.head);
  const keep = keepSet(pills, s.head);
  const vr = visibleRows(s.commits, { hideCi: s.settings.hideCi, isCi, keep, headSha: s.head.sha, dirty: s.wip !== null });
  const lay = layout(vr.rows);
  return {
    rows: lay.rows, width: graphWidth(lay.max), pills, hiddenN: vr.hiddenN,
    ciTotal: s.commits.filter(isCi).length, isCi,
    bySha: new Map(s.commits.map((c) => [c.sha, c])),
    known: new Set(lay.rows.filter((r) => !r.wip).map((r) => r.sha)),
    indexOf: new Map(lay.rows.map((r, i) => [r.sha, i])),
  };
}

function rowEnv(s: State, m: Model): RowEnv {
  return {
    width: m.width, selected, headSha: s.head.sha, jira: s.settings.jira, pills: m.pills, isCi: m.isCi,
    query: query.trim().toLowerCase(), nowMs: Date.now(), wipCount: s.wip ? s.wip.staged.length + s.wip.unstaged.length : 0,
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

function renderDetails(): void {
  if (!st || !model) { details.innerHTML = noDetailsHtml; return; }
  if (selected === WIP_SHA && st.wip) { details.innerHTML = wipDetailsHtml(st.wip, st.head); return; }
  const c = selected ? model.bySha.get(selected) : undefined;
  if (!c) { details.innerHTML = noDetailsHtml; return; }
  const f = files.get(c.sha);
  const fs: FilesState = f === undefined ? 'loading' : f;
  details.innerHTML = commitDetailsHtml(c, fs, { jira: st.settings.jira, pills: model.pills, nowMs: Date.now(), known: model.known });
}

function renderToolbar(): void {
  if (!st || !model) return;
  $('repo').textContent = `${st.repo.name} ▾`;
  // One repo in the window: nothing to switch to, so the chip is hidden (the tab title still names the repo).
  $('repo').hidden = !st.multiRepo;
  const ci = $('ci');
  const label = st.settings.ciPattern === '^AutoBuild$' ? 'AutoBuild' : 'CI';
  ci.textContent = `Hide ${label} · ${st.settings.hideCi ? `${model.hiddenN} hidden` : model.ciTotal}`;
  ci.setAttribute('aria-pressed', String(st.settings.hideCi));
  const n = st.commits.length - (st.settings.hideCi ? model.hiddenN : 0);
  $('cnt').textContent = `${n}${st.commits.length >= st.settings.logLimit ? '+' : ''} commits`;
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
  selected = sha;
  scrollToRow(sha, !!o.center);
  renderRows(true);
  if (changed) details.scrollTop = 0;
  renderDetails();
  if (changed && sha !== WIP_SHA && !files.has(sha) && model?.bySha.has(sha)) send({ type: 'select', sha });
}

function defaultSelection(): string | null {
  if (!st || !model) return null;
  if (selected && ((selected === WIP_SHA && st.wip) || model.known.has(selected))) return selected;
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
  if (st && st.repo.root !== s.repo.root) { files.clear(); selected = null; list.scrollTop = 0; }
  if (files.size > 500) files.clear();
  st = s;
  model = build(s);
  showMessage(null);
  renderToolbar();
  const want = pendingReveal;
  pendingReveal = null;
  if (want && model.known.has(want)) selected = want;
  const sel = defaultSelection();
  selected = sel;
  if (want && sel === want) scrollToRow(want, true);
  renderRows(true);
  renderDetails();
  // Ask for the files of a commit we have none for (first state, or the selection moved to a new commit).
  if (sel && sel !== WIP_SHA && !files.has(sel) && model.bySha.has(sel)) send({ type: 'select', sha: sel });
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'state': onState(m); break;
    case 'details':
      files.set(m.sha, m.error !== undefined ? { error: m.error } : m.files);
      if (m.sha === selected) renderDetails();
      break;
    case 'reveal':
      if (model?.known.has(m.sha)) select(m.sha, { center: true });
      else pendingReveal = m.sha;
      break;
    case 'busy': $('busy').hidden = !m.on; break;
    case 'error': st = undefined; model = undefined; selected = null; renderRows(); renderDetails(); showMessage(m.message); break;
  }
});

// Rows.
rowsEl.addEventListener('click', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.gr');
  if (!row?.dataset.sha) return;
  select(row.dataset.sha);
  list.focus();
});
list.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderRows(); });
}, { passive: true });
new ResizeObserver(() => renderRows()).observe(list);

// Details card.
details.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-url],[data-select],[data-scm],[data-file],[data-copy]');
  if (!t || !st) return;
  if (t.dataset.copy) send({ type: 'copy', text: t.dataset.copy });
  else if (t.dataset.url) send({ type: 'openUrl', url: t.dataset.url });
  else if (t.dataset.select) { if (model?.known.has(t.dataset.select)) select(t.dataset.select, { center: true }); }
  else if (t.dataset.scm) send({ type: 'openScm' });
  else if (t.dataset.file !== undefined) {
    const i = Number(t.dataset.file);
    if (t.dataset.area === 'commit') {
      const f = selected ? files.get(selected) : undefined;
      if (selected && Array.isArray(f) && f[i]) send({ type: 'openCommitFile', sha: selected, file: f[i] });
    } else if (st.wip && (t.dataset.area === 'staged' || t.dataset.area === 'unstaged')) {
      const file = wipFile(st.wip, t.dataset.area, i);
      if (file) send({ type: 'openWipFile', file, area: t.dataset.area });
    }
  }
});

// Toolbar.
$('repo').addEventListener('click', () => send({ type: 'switchRepo' }));
$('refresh').addEventListener('click', () => send({ type: 'refresh' }));
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
qEl.addEventListener('input', () => { query = qEl.value; renderRows(true); });
qEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') jumpToMatch(ev.shiftKey ? -1 : 1);
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
  const dir = ev.key === 'ArrowDown' || ev.key === 'j' ? 1 : ev.key === 'ArrowUp' || ev.key === 'k' ? -1 : 0;
  if (!dir || !model?.rows.length) return;
  ev.preventDefault();
  const i = selected ? model.indexOf.get(selected) : undefined;
  const next = i === undefined ? (dir > 0 ? 0 : model.rows.length - 1) : Math.min(model.rows.length - 1, Math.max(0, i + dir));
  select(model.rows[next].sha);
});

renderDetails();
send({ type: 'ready' });
