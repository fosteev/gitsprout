// @vitest-environment happy-dom
// Smoke test of the settings page (webview/settings/main.ts): rendering from a state fixture, edits, search, scope, preview.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromSettings, SettingsState, ToSettings } from '../src/settings/protocol';

const state = (o: Partial<SettingsState> = {}): SettingsState => ({
  categories: [
    { title: 'Diff', settings: [
      { key: 'diff.syntaxHighlighting', type: 'boolean', default: true, description: 'Highlight syntax in the graph.' },
      { key: 'diff.highlightTheme', type: 'string', default: 'auto', description: 'Colour palette.', enum: ['auto', 'simple'], enumDescriptions: ['Theme colours.', 'Small palette.'] },
      { key: 'diff.fontFamily', type: 'string', default: '', description: 'Font family of the diff.' },
      { key: 'diff.fontSize', type: 'number', default: 0, description: 'Font size in pixels.', minimum: 0, maximum: 40 },
    ] },
    { title: 'Repositories', settings: [
      { key: 'scanExclude', type: 'stringArray', default: ['**/node_modules'], description: 'Glob patterns skipped.' },
    ] },
    { title: 'Jira', settings: [
      { key: 'jira', type: 'stringMap', default: {}, description: 'Jira project key to browse URL prefix.' },
    ] },
  ],
  scope: 'user', hasWorkspace: true,
  values: { 'diff.syntaxHighlighting': true, 'diff.highlightTheme': 'auto', 'diff.fontFamily': '', 'diff.fontSize': 0, scanExclude: ['**/node_modules'], jira: {} },
  modified: [], themeLabel: 'Dark Modern', downloadedFonts: [], tokens: null, fontFaces: [],
  ...o,
});

let posted: FromSettings[];
const post = (s: SettingsState): void => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: s } satisfies ToSettings })); };
const q = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const qa = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
const sent = <T extends FromSettings['type']>(type: T): Extract<FromSettings, { type: T }>[] => posted.filter((m) => m.type === type) as Extract<FromSettings, { type: T }>[];
const change = (el: HTMLElement): void => { el.dispatchEvent(new Event('change', { bubbles: true })); };

const listeners: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject }[] = [];
for (const target of [window, document] as EventTarget[]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: unknown) => {
    listeners.push({ target, type, fn });
    add(type, fn, o as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function load(s: SettingsState = state()): Promise<void> {
  for (const l of listeners.splice(0)) l.target.removeEventListener(l.type, l.fn);
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  posted = [];
  (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({ postMessage: (m: FromSettings) => posted.push(m), setState: () => {}, getState: () => undefined });
  await import('../webview/settings/main');
  post(s);
}

beforeEach(async () => { await load(); });

describe('settings page', () => {
  it('announces itself and renders the categories and a row per setting', () => {
    expect(sent('ready')).toHaveLength(1);
    expect(qa('#main h3').map((h) => h.textContent)).toEqual(['Diff', 'Repositories', 'Jira']);
    expect(qa('#main .set')).toHaveLength(6);
    expect(q('#set-diff\\.syntaxHighlighting .stt').textContent).toContain('Syntax Highlighting');
    expect(q('#set-diff\\.syntaxHighlighting .stt code').textContent).toBe('gitsprout.diff.syntaxHighlighting');
  });

  it('a checkbox change posts set with the scope', () => {
    const cb = q<HTMLInputElement>('input[data-k="diff.syntaxHighlighting"]');
    cb.checked = false;
    change(cb);
    expect(sent('set')).toEqual([{ type: 'set', key: 'diff.syntaxHighlighting', value: false, scope: 'user' }]);
  });

  it('a number input posts a number; garbage is not sent', () => {
    const n = q<HTMLInputElement>('input[data-k="diff.fontSize"]');
    n.value = '14';
    change(n);
    expect(sent('set').at(-1)).toMatchObject({ key: 'diff.fontSize', value: 14 });
    n.value = '';
    change(n);
    expect(sent('set')).toHaveLength(1);
  });

  it('Reset is shown for a modified row and posts reset', () => {
    post(state({ modified: ['diff.fontSize'], values: { ...state().values, 'diff.fontSize': 16 } }));
    expect(q('#set-diff\\.fontSize').classList.contains('mod')).toBe(true);
    expect(q('#set-diff\\.syntaxHighlighting').classList.contains('mod')).toBe(false);
    q('#set-diff\\.fontSize [data-act="reset"]').click();
    expect(sent('reset')).toEqual([{ type: 'reset', key: 'diff.fontSize', scope: 'user' }]);
  });

  it('list: Add Pattern appends, the delete button removes', () => {
    const row = q('#set-scanExclude');
    const input = row.querySelector<HTMLInputElement>('[data-add="scanExclude"]')!;
    input.value = '**/dist';
    row.querySelector<HTMLElement>('[data-act="add"]')!.click();
    expect(sent('set').at(-1)).toMatchObject({ key: 'scanExclude', value: ['**/node_modules', '**/dist'] });
    row.querySelector<HTMLElement>('[data-act="del"]')!.click();
    expect(sent('set').at(-1)).toMatchObject({ key: 'scanExclude', value: [] });
  });

  it('map: key + URL rows add an entry', () => {
    const row = q('#set-jira');
    const [k, u] = [...row.querySelectorAll<HTMLInputElement>('[data-add="jira"]')];
    k.value = 'PROJ';
    row.querySelector<HTMLElement>('[data-act="add"]')!.click();
    expect(sent('set')).toHaveLength(0); // the URL is missing
    u.value = 'https://jira.example.com/browse/';
    row.querySelector<HTMLElement>('[data-act="add"]')!.click();
    expect(sent('set').at(-1)).toMatchObject({ key: 'jira', value: { PROJ: 'https://jira.example.com/browse/' } });
  });

  it('search hides rows and the categories left empty', () => {
    const qEl = q<HTMLInputElement>('#q');
    qEl.value = 'glob';
    qEl.dispatchEvent(new Event('input', { bubbles: true }));
    expect(qa('#main .set').filter((r) => !r.hidden).map((r) => r.dataset.key)).toEqual(['scanExclude']);
    expect(qa('#main h3').filter((h) => !h.hidden).map((h) => h.textContent)).toEqual(['Repositories']);
    qEl.value = '';
    qEl.dispatchEvent(new Event('input', { bubbles: true }));
    expect(qa('#main .set').every((r) => !r.hidden)).toBe(true);
  });

  it('the Workspace tab is disabled without a workspace folder; User/Workspace posts scope', async () => {
    await load(state({ hasWorkspace: false }));
    expect(q<HTMLButtonElement>('#scope [data-arg="workspace"]').disabled).toBe(true);
    post(state());
    const ws = q<HTMLButtonElement>('#scope [data-arg="workspace"]');
    expect(ws.disabled).toBe(false);
    ws.click();
    expect(sent('scope')).toEqual([{ type: 'scope', scope: 'workspace' }]);
    post(state({ scope: 'workspace' }));
    q('#set-diff\\.fontSize [data-act="reset"]').click();
    expect(sent('reset')[0].scope).toBe('workspace');
  });

  it('the preview renders the sample hunk, highlighted, and re-renders on the mode chips', () => {
    const body = q('#set-diff\\.fontSize .pvbody');
    expect(body.querySelector('.dinl')).not.toBeNull();
    expect(body.querySelector('.dgrid.hl')).not.toBeNull();
    expect(body.textContent).toContain('cents');
    q('#set-diff\\.fontSize [data-arg="split"]').click();
    expect(q('#set-diff\\.fontSize .pvbody .dsbs')).not.toBeNull();
    expect(q('#set-diff\\.fontSize [data-arg="split"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('highlighting off: plain preview, the theme select is disabled', () => {
    post(state({ values: { ...state().values, 'diff.syntaxHighlighting': false } }));
    expect(q('#set-diff\\.fontSize .pvbody .dgrid.hl')).toBeNull();
    expect(q<HTMLSelectElement>('#set-diff\\.highlightTheme select').disabled).toBe(true);
  });

  it('font row: source line, Google Fonts button, Remove download for a downloaded family', () => {
    expect(q('#set-diff\\.fontFamily .sh').textContent).toContain('editor.fontFamily');
    q('#set-diff\\.fontFamily [data-act="gf-pick"]').click();
    expect(sent('downloadFont')).toHaveLength(1);
    post(state({ downloadedFonts: ['JetBrains Mono'], values: { ...state().values, 'diff.fontFamily': 'JetBrains Mono' } }));
    expect(q('#set-diff\\.fontFamily .gfb').textContent).toContain('GOOGLE FONTS');
    q('#set-diff\\.fontFamily [data-act="gf-remove"]').click();
    expect(sent('removeFont')).toEqual([{ type: 'removeFont', family: 'JetBrains Mono' }]);
  });

  it('the auto theme shows which theme is meant', () => {
    expect(q('#set-diff\\.highlightTheme .sh').textContent).toContain('Dark Modern');
  });
});
