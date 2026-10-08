// Settings page entry point: a front end over the native gitsprout.* configuration. The host owns the values
// (src/settings/panel.ts); every edit is a message, the page re-renders from the `state` the host pushes back.
import type { DiffStyle, HighlightTheme } from '../../src/graph/protocol';
import type { FilePatch } from '../../src/git/types';
import type { FromSettings, SettingSchema, SettingsScope, SettingsState, ToSettings } from '../../src/settings/protocol';
import '../base.css';
import '../diff.css';
import '../tokens.css';
import './styles.css';
import { applyDiffStyle } from '../diffStyle';
import { esc } from '../format';
import { languageFor } from '../highlight';
import { diffBodyHtml, type DiffMode } from '../render';

declare function acquireVsCodeApi(): { postMessage(m: FromSettings): void; setState(s: unknown): void; getState?(): unknown };
const api = acquireVsCodeApi();
const send = (m: FromSettings): void => api.postMessage(m);

const PREFIX = 'gitsprout.';
const THEMES: readonly string[] = ['auto', 'simple', 'github', 'one'];
const ADD_LABEL: Record<string, string> = { scanExclude: 'Add Pattern', jira: 'Add Project' };
const WORDS: Record<string, string> = { Ci: 'CI' };

/** "diff.syntaxHighlighting" -> "Syntax Highlighting" */
function titleFromKey(key: string): string {
  const last = key.slice(key.lastIndexOf('.') + 1);
  return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((w) => { const c = w.charAt(0).toUpperCase() + w.slice(1); return WORDS[c] ?? c; }).join(' ');
}

let state: SettingsState | undefined;
let query = '';
let pvMode: DiffMode = 'inline';
/** Rendered HTML per setting row: a row is touched only when its HTML changes (keeps focus, scroll and half-typed text). */
const rowCache = new Map<string, string>();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ---------- preview ---------- */
const PV_LINES: [' ' | '-' | '+', string][] = [
  [' ', '  /**'],
  [' ', '   * Sum of the line prices,'],
  ['-', '   * rounded with toFixed.'],
  ['+', '   * rounded half-up to whole cents.'],
  [' ', '   */'],
  [' ', '  total(lines: CartLine[]): string {'],
  ['-', '    const sum = lines.reduce((s, l) => s + l.price * l.qty, 0);'],
  ['-', '    return sum.toFixed(2);'],
  ['+', '    let cents = 0;'],
  ['+', '    for (const l of lines) {'],
  ['+', '      cents += Math.round(l.price * 100) * l.qty;'],
  ['+', '    }'],
  ['+', '    return `${this.currency} ${(cents / 100).toFixed(2)}`;'],
  [' ', '  }'],
];
const PV_PATH = 'src/cart/totals.ts';

function previewPatch(): FilePatch {
  let o = 8, n = 8;
  return {
    binary: false, truncated: false,
    hunks: [{
      header: '@@ -8,11 +8,14 @@ export class CartTotals', oldStart: 8, newStart: 8,
      lines: PV_LINES.map(([kind, text]) => ({ kind, text, old: kind === '+' ? null : o++, new: kind === '-' ? null : n++ })),
    }],
  };
}

/** The style the preview shows: the page's shown values, as the graph would get them from `diffStyle()`. */
function previewStyle(s: SettingsState): DiffStyle {
  const v = s.values;
  const theme = (THEMES.includes(String(v['diff.highlightTheme'])) ? v['diff.highlightTheme'] : 'auto') as HighlightTheme;
  const size = Number(v['diff.fontSize']);
  return {
    highlight: v['diff.syntaxHighlighting'] !== false,
    theme,
    tokens: theme === 'auto' ? s.tokens : null,
    fontFamily: typeof v['diff.fontFamily'] === 'string' ? v['diff.fontFamily'].trim() : '',
    fontSize: Number.isFinite(size) ? Math.min(40, Math.max(0, size)) : 0,
    fontFaces: s.fontFaces,
  };
}

function previewHtml(s: SettingsState): string {
  const st = previewStyle(s);
  const lang = st.highlight ? languageFor(PV_PATH) : null;
  const cap = !st.highlight ? 'highlighting off' : st.theme === 'auto' ? `colours of ${esc(s.themeLabel)}` : 'light or dark variant by theme kind';
  const chip = (m: DiffMode, label: string): string => `<button class="vchip" data-act="pv-mode" data-arg="${m}" aria-pressed="${pvMode === m}">${label}</button>`;
  return `<div class="pv"><div class="pvcap">Preview<span>${cap}</span></div>
    <div class="pvbar"><span class="s">M</span><span class="dir">src/cart/</span><b>totals.ts</b><span class="ctx">· Working Tree</span>${chip('inline', 'Inline')}${chip('split', 'Side by Side')}</div>
    <div class="pvbody">${diffBodyHtml(previewPatch(), pvMode, lang)}</div></div>`;
}

/* ---------- rows ---------- */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function fontSource(s: SettingsState, v: unknown): string {
  const fam = typeof v === 'string' ? v.split(',')[0].trim().replace(/^["']|["']$/g, '') : '';
  if (!fam) return 'Uses <code>editor.fontFamily</code>.';
  const dl = s.downloadedFonts.find((f) => f.toLowerCase() === fam.toLowerCase());
  if (dl) return `<span class="gfb">GOOGLE FONTS · OFFLINE</span> Stored in the extension storage. <button class="lnk" data-act="gf-remove" data-arg="${esc(dl)}">Remove download</button>`;
  return 'Installed font; if it is missing, the diff falls back to the editor font.';
}

function controlHtml(s: SettingsState, it: SettingSchema): string {
  const v = s.values[it.key];
  const k = esc(it.key);
  switch (it.type) {
    case 'boolean':
      return `<label class="cbx"><input type="checkbox" data-k="${k}" data-f="${k}" ${v === true ? 'checked' : ''}><span>${esc(it.description)}</span></label>`;
    case 'number':
      return `<input class="nin" type="number" step="any" data-k="${k}" data-f="${k}" value="${esc(String(v ?? ''))}"${it.minimum !== undefined ? ` min="${it.minimum}"` : ''}${it.maximum !== undefined ? ` max="${it.maximum}"` : ''}>`;
    case 'string': {
      if (it.enum) {
        const off = it.key === 'diff.highlightTheme' && s.values['diff.syntaxHighlighting'] === false;
        const i = it.enum.indexOf(String(v));
        const note = (it.enumDescriptions?.[i] ?? '') + (v === 'auto' ? ` Now: <code>${esc(s.themeLabel)}</code>.` : '');
        return `<select class="ssel" data-k="${k}" data-f="${k}" ${off ? 'disabled' : ''}>${it.enum.map((e) => `<option value="${esc(e)}" ${v === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
          <div class="sh">${note.trim()}</div>`;
      }
      if (it.key === 'diff.fontFamily') {
        return `<div class="frow"><input class="tin" data-k="${k}" data-f="${k}" value="${esc(String(v ?? ''))}" placeholder="Editor font">
          <button class="vbtn sec" data-act="gf-pick">Google Fonts…</button></div><div class="sh">${fontSource(s, v)}</div>`;
      }
      return `<input class="tin" data-k="${k}" data-f="${k}" value="${esc(String(v ?? ''))}">`;
    }
    case 'stringArray': {
      const items = Array.isArray(v) ? (v as string[]) : [];
      return `<div class="slist">${items.map((p, i) => `<div class="li"><span>${esc(p)}</span><button class="ib" data-act="del" data-arg="${k}" data-i="${i}" title="Remove" aria-label="Remove">${X}</button></div>`).join('')}</div>
        <div class="addrow"><input class="tin" data-add="${k}" data-f="${k}:add" placeholder="${esc(ADD_LABEL[it.key] ?? 'Add')}…"><button class="vbtn" data-act="add" data-arg="${k}">${esc(ADD_LABEL[it.key] ?? 'Add')}</button></div>`;
    }
    case 'stringMap': {
      const entries = v && typeof v === 'object' ? Object.entries(v as Record<string, string>) : [];
      return `<div class="slist">${entries.map(([a, b]) => `<div class="li"><span class="k">${esc(a)}</span><span>${esc(b)}</span><button class="ib" data-act="del" data-arg="${k}" data-i="${esc(a)}" title="Remove" aria-label="Remove">${X}</button></div>`).join('') || '<div class="sh none">Nothing yet.</div>'}</div>
        <div class="addrow"><input class="tin kin" data-add="${k}" data-role="key" data-f="${k}:add" placeholder="Key"><input class="tin" data-add="${k}" data-role="value" data-f="${k}:val" placeholder="URL"><button class="vbtn" data-act="add" data-arg="${k}">${esc(ADD_LABEL[it.key] ?? 'Add')}</button></div>`;
    }
  }
}
const X = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function rowHtml(s: SettingsState, it: SettingSchema): string {
  const bool = it.type === 'boolean';
  return `<div class="stt">${esc(titleFromKey(it.key))}<code>${PREFIX}${esc(it.key)}</code><button class="lnk" data-act="reset" data-arg="${esc(it.key)}">Reset</button></div>
    ${bool ? '' : `<div class="sd">${esc(it.description)}</div>`}${controlHtml(s, it)}${it.key === 'diff.fontSize' ? previewHtml(s) : ''}`;
}

const searchText = (it: SettingSchema): string => `${titleFromKey(it.key)} ${PREFIX}${it.key} ${it.description}`.toLowerCase();

/* ---------- shell ---------- */
function buildShell(s: SettingsState): void {
  $('app').innerHTML = `<div class="sp">
    <div class="sphead">
      <div class="sprow"><input class="vin" id="q" placeholder="Search Gitsprout settings" autocomplete="off" aria-label="Search settings">
        <button class="lnk" data-act="native" title="workbench.action.openSettings @ext:gitsprout">Open in VS Code Settings</button>
        <button class="lnk" data-act="json" title="Opens settings.json of the selected scope">Edit in settings.json</button></div>
      <div class="scope" id="scope"></div>
    </div>
    <div class="spbody">
      <nav class="spnav" id="nav">${s.categories.map((c, i) => `<button data-act="nav" data-arg="${i}" class="${i ? '' : 'on'}">${esc(c.title)}</button>`).join('')}</nav>
      <div class="spmain" id="main">${s.categories.map((c, i) => `<h3 id="sec-${i}">${esc(c.title)}</h3>${c.settings.map((it) => `<div class="set" id="set-${esc(it.key)}" data-key="${esc(it.key)}" data-text="${esc(searchText(it))}"></div>`).join('')}`).join('')}</div>
    </div>
  </div>`;
  $<HTMLInputElement>('q').value = query;
}

function renderScope(s: SettingsState): void {
  const btn = (sc: SettingsScope): string => `<button data-act="scope" data-arg="${sc}" aria-pressed="${s.scope === sc}" ${sc === 'workspace' && !s.hasWorkspace ? 'disabled title="Open a folder to use workspace settings"' : ''}>${sc}</button>`;
  $('scope').innerHTML = `${btn('user')}${btn('workspace')}<span class="sn">${s.scope === 'user' ? 'Applies to every window' : 'Overrides User for this workspace (.vscode/settings.json)'}</span>`;
}

function renderRows(s: SettingsState): void {
  const main = $('main');
  const top = main.scrollTop;
  for (const c of s.categories) for (const it of c.settings) {
    const el = $(`set-${it.key}`);
    el.classList.toggle('mod', s.modified.includes(it.key));
    const html = rowHtml(s, it);
    if (rowCache.get(it.key) === html) continue;
    rowCache.set(it.key, html);
    const active = document.activeElement as HTMLElement | null;
    const keep = active && el.contains(active) ? { f: active.dataset.f, value: (active as HTMLInputElement).value, at: (active as HTMLInputElement).selectionStart } : undefined;
    el.innerHTML = html;
    if (keep?.f) {
      const next = el.querySelector<HTMLInputElement>(`[data-f="${keep.f}"]`);
      if (next) {
        // a half-typed add field keeps its text; committed controls take the value from the host
        if (next.dataset.add !== undefined) next.value = keep.value;
        next.focus();
        if (keep.at !== null && next.type === 'text') try { next.setSelectionRange(keep.at, keep.at); } catch { /* not selectable */ }
      }
    }
  }
  main.scrollTop = top;
}

/** Hides rows that do not match the search and categories left without a row. */
function applyFilter(): void {
  const q = query.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>('#main .set').forEach((el) => { el.hidden = !!q && !(el.dataset.text ?? '').includes(q); });
  document.querySelectorAll<HTMLElement>('#main h3').forEach((h) => {
    let el = h.nextElementSibling, any = false;
    while (el && el.tagName !== 'H3') { if (!(el as HTMLElement).hidden) any = true; el = el.nextElementSibling; }
    h.hidden = !any;
  });
  spy();
}

function spy(): void {
  if (!state) return;
  const m = $('main');
  let cur = 0;
  state.categories.forEach((_, i) => { const h = $(`sec-${i}`); if (!h.hidden && h.offsetTop <= m.scrollTop + 30) cur = i; });
  document.querySelectorAll<HTMLElement>('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.arg === String(cur)));
}

function render(s: SettingsState): void {
  state = s;
  if (!document.getElementById('main')) buildShell(s);
  renderScope(s);
  renderRows(s);
  applyDiffStyle(previewStyle(s));
  applyFilter();
}

/* ---------- edits ---------- */
const find = (key: string): SettingSchema | undefined => state?.categories.flatMap((c) => c.settings).find((it) => it.key === key);
const set = (key: string, value: unknown): void => { if (state) send({ type: 'set', key, value, scope: state.scope }); };

function addTo(key: string, row: HTMLElement): void {
  const it = find(key);
  if (!it || !state) return;
  const inputs = [...row.querySelectorAll<HTMLInputElement>(`[data-add="${key}"]`)];
  const cur = state.values[key];
  if (it.type === 'stringArray') {
    const text = inputs[0]?.value.trim();
    if (!text) return;
    const list = Array.isArray(cur) ? (cur as string[]) : [];
    if (!list.includes(text)) set(key, [...list, text]);
    inputs[0].value = '';
  } else if (it.type === 'stringMap') {
    const k = inputs.find((i) => i.dataset.role === 'key')?.value.trim();
    const u = inputs.find((i) => i.dataset.role === 'value')?.value.trim();
    if (!k || !u) return;
    set(key, { ...((cur && typeof cur === 'object' ? cur : {}) as Record<string, string>), [k]: u });
    for (const i of inputs) i.value = '';
  }
}

document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!t || !state) return;
  const arg = t.dataset.arg ?? '';
  switch (t.dataset.act) {
    case 'reset': send({ type: 'reset', key: arg, scope: state.scope }); break;
    case 'scope': if (arg === 'user' || arg === 'workspace') send({ type: 'scope', scope: arg }); break;
    case 'native': send({ type: 'openNative' }); break;
    case 'json': send({ type: 'openJson', scope: state.scope }); break;
    case 'gf-pick': send({ type: 'downloadFont' }); break;
    case 'gf-remove': send({ type: 'removeFont', family: arg }); break;
    case 'pv-mode': pvMode = arg === 'split' ? 'split' : 'inline'; render(state); break;
    case 'nav': {
      const h = document.getElementById(`sec-${arg}`);
      if (h) $('main').scrollTo({ top: h.offsetTop - 4 });
      break;
    }
    case 'add': { const row = t.closest<HTMLElement>('.set'); if (row) addTo(arg, row); break; }
    case 'del': {
      const it = find(arg);
      const cur = state.values[arg];
      if (!it) break;
      if (it.type === 'stringArray' && Array.isArray(cur)) set(arg, (cur as string[]).filter((_, i) => String(i) !== t.dataset.i));
      else if (it.type === 'stringMap' && cur && typeof cur === 'object') {
        const { [t.dataset.i ?? '']: _gone, ...rest } = cur as Record<string, string>;
        set(arg, rest);
      }
      break;
    }
  }
});

// Inputs commit on `change` (blur / Enter), not per keystroke: the host re-pushes the state after every write.
document.addEventListener('change', (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const key = el.dataset?.k;
  if (!key || !state) return;
  const it = find(key);
  if (!it) return;
  if (it.type === 'boolean') set(key, (el as HTMLInputElement).checked);
  else if (it.type === 'number') {
    const n = el.value.trim() === '' ? NaN : Number(el.value);
    if (Number.isFinite(n)) set(key, n); else { rowCache.delete(key); render(state); } // empty / garbage: put the stored value back
  } else set(key, el.value);
});

document.addEventListener('keydown', (ev) => {
  const el = ev.target as HTMLElement;
  if (ev.key === 'Enter' && el.dataset?.add !== undefined) {
    const row = el.closest<HTMLElement>('.set');
    if (row) addTo(el.dataset.add, row);
  }
});

document.addEventListener('input', (ev) => {
  if ((ev.target as HTMLElement).id !== 'q') return;
  query = (ev.target as HTMLInputElement).value;
  applyFilter();
});

window.addEventListener('message', (ev: MessageEvent<ToSettings>) => {
  if (ev.data?.type === 'state') render(ev.data.state);
});

document.getElementById('app')?.addEventListener('scroll', spy, true);
send({ type: 'ready' });
