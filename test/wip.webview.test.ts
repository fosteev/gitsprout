// @vitest-environment happy-dom
// Smoke test of webview/main.ts in a DOM: the commit box must survive `state` messages (roadmap-wip-panel, "Re-render rule").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../src/git/types';
import type { FromWebview, ToWebview } from '../src/graph/protocol';

const SHA = 'a'.repeat(40);
const f = (path: string, o: Partial<FileChange> = {}): FileChange => ({ path, origPath: null, status: 'M', untracked: false, ...o });

type StateMsg = Extract<ToWebview, { type: 'state' }>;
const stateMsg = (o: { staged?: FileChange[]; unstaged?: FileChange[]; sha?: string | null } = {}): StateMsg => ({
  type: 'state', repo: { root: '/r', name: 'r' }, multiRepo: false,
  head: { branch: 'main', sha: o.sha === undefined ? SHA : o.sha },
  commits: [{ sha: SHA, parents: [], author: 'A', email: 'a@x', time: 1, subject: 'init', body: '' }],
  refs: { head: { branch: 'main', sha: SHA }, locals: [], remotes: [], tags: [] },
  wip: { staged: o.staged ?? [], unstaged: o.unstaged ?? [f('src/a.ts'), f('n.txt', { status: 'A', untracked: true })] },
  settings: { ciPattern: '', hideCi: false, jira: {}, logLimit: 1000 },
});

let posted: FromWebview[];
let saved: unknown;
const post = (m: ToWebview): void => { window.dispatchEvent(new MessageEvent('message', { data: m })); };
const q = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const sent = (type: string): FromWebview[] => posted.filter((m) => m.type === type);

// Every load() imports main.ts afresh and it registers window/document listeners: drop the previous generation's.
const listeners: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject }[] = [];
for (const target of [window, document] as EventTarget[]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: unknown) => {
    listeners.push({ target, type, fn });
    add(type, fn, o as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function load(restored?: unknown): Promise<void> {
  for (const l of listeners.splice(0)) l.target.removeEventListener(l.type, l.fn);
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  posted = [];
  saved = restored;
  (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: FromWebview) => posted.push(m),
    setState: (s: unknown) => { saved = s; },
    getState: () => saved,
  });
  await import('../webview/main');
}

const selectWip = (): void => { q('.gr[data-sha="WIP"]').click(); };
/** The extension's answer to a git action: wipBusy on/off, then the refreshed state. */
const roundTrip = (st: StateMsg): void => { post({ type: 'wipBusy', on: true }); post({ type: 'wipBusy', on: false }); post(st); };
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string): void => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

beforeEach(async () => { await load(); });

describe('WIP panel in the webview', () => {
  it('survives a state message: typed text and focus stay', () => {
    post(stateMsg());
    selectWip();
    const sum = q<HTMLInputElement>('#wsum');
    sum.focus();
    type(sum, 'Fix the thing');
    type(q<HTMLTextAreaElement>('#wdesc'), 'because');
    sum.setSelectionRange(3, 3);
    post(stateMsg({ unstaged: [f('src/a.ts'), f('n.txt', { status: 'A', untracked: true }), f('extra.txt')] }));
    expect(q('#wsum')).toBe(sum);
    expect(q<HTMLInputElement>('#wsum').value).toBe('Fix the thing');
    expect(document.activeElement).toBe(sum);
    expect(sum.selectionStart).toBe(3);
    expect(q<HTMLTextAreaElement>('#wdesc').value).toBe('because');
    expect(document.querySelectorAll('#wip-lists .tr.w:not(.dir)').length).toBe(3); // lists did re-render
    expect(q('.gr[data-sha="WIP"] .wip').textContent).toBe('Fix the thing');
    expect(q('#wcnt').textContent).toBe(String(72 - 'Fix the thing'.length));
  });

  it('stage on a row posts one file', () => {
    post(stateMsg());
    selectWip();
    const row = q('#wip-lists .tr.w[title="n.txt"]');
    row.querySelector<HTMLElement>('[data-act="stage"]')?.click();
    expect(sent('stage')).toEqual([{ type: 'stage', files: [f('n.txt', { status: 'A', untracked: true })] }]);
    expect(sent('openWipFile')).toEqual([]); // the button does not also open the diff
    q('#wip-lists .tr.w[title="src/a.ts"] .tl').click();
    expect(sent('openWipFile')).toMatchObject([{ area: 'unstaged', file: { path: 'src/a.ts' } }]);
  });

  it('no discard button on a conflicted row', () => {
    post(stateMsg({ unstaged: [f('c.txt', { status: 'U' })] }));
    selectWip();
    expect(document.querySelector('[data-act="discard"]')).toBeNull();
  });

  it('primary button with an empty summary: error, no commit', () => {
    post(stateMsg({ staged: [f('src/a.ts')], unstaged: [] }));
    selectWip();
    expect(q('#wprimary').textContent).toContain('Commit Changes to 1 File');
    q('#wprimary').click();
    expect(sent('commit')).toEqual([]);
    expect(q('#werr').hidden).toBe(false);
    expect(q('#werr').textContent).toBe('Enter a commit summary.');
    expect(document.activeElement).toBe(q('#wsum'));
    type(q<HTMLInputElement>('#wsum'), 'x');
    expect(q('#werr').hidden).toBe(true);
  });

  it('commit sends the draft; Commit and Push sets push; Cmd+Enter commits', () => {
    post(stateMsg({ staged: [f('src/a.ts')], unstaged: [] }));
    selectWip();
    type(q<HTMLInputElement>('#wsum'), 'Add a');
    type(q<HTMLTextAreaElement>('#wdesc'), 'body');
    const staged = stateMsg({ staged: [f('src/a.ts')], unstaged: [] });
    q('#wprimary').click();
    roundTrip(staged);
    q('#wmore').click();
    expect(q('#wmenu').hidden).toBe(false);
    q<HTMLElement>('#wmenu [data-act="commitPush"]').click();
    roundTrip(staged);
    q('#wsum').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(sent('commit')).toEqual([
      { type: 'commit', summary: 'Add a', description: 'body', amend: false, push: false },
      { type: 'commit', summary: 'Add a', description: 'body', amend: false, push: true },
      { type: 'commit', summary: 'Add a', description: 'body', amend: false, push: false },
    ]);
  });

  it('nothing staged: the primary button stages all instead of committing', () => {
    post(stateMsg());
    selectWip();
    expect(q('#wprimary').textContent).toContain('Stage Changes to Commit');
    expect(q('#wmore').hidden).toBe(true);
    q('#wprimary').click();
    expect(sent('stageAll')).toHaveLength(1);
    expect(sent('commit')).toEqual([]);
  });

  it('committed clears the draft whatever the order of state and committed', () => {
    post(stateMsg({ staged: [f('src/a.ts')], unstaged: [] }));
    selectWip();
    type(q<HTMLInputElement>('#wsum'), 'Add a');
    type(q<HTMLTextAreaElement>('#wdesc'), 'body');
    post({ type: 'committed', sha: 'b'.repeat(40) });
    post(stateMsg({ staged: [], unstaged: [f('other.txt')] }));
    expect(q<HTMLInputElement>('#wsum').value).toBe('');
    expect(q<HTMLTextAreaElement>('#wdesc').value).toBe('');
    expect(q('.gr[data-sha="WIP"] .wip').textContent).toBe('// WIP');
    expect((saved as { draft: unknown }).draft).toEqual({ summary: '', description: '', amend: false });
    // state first, then committed
    type(q<HTMLInputElement>('#wsum'), 'again');
    post(stateMsg());
    post({ type: 'committed', sha: 'c'.repeat(40) });
    expect(q<HTMLInputElement>('#wsum').value).toBe('');
  });

  it('a failed commit keeps the draft (nothing is posted)', () => {
    post(stateMsg({ staged: [f('a')], unstaged: [] }));
    selectWip();
    type(q<HTMLInputElement>('#wsum'), 'keep me');
    post({ type: 'wipBusy', on: true });
    expect(q<HTMLButtonElement>('#wprimary').disabled).toBe(true);
    expect(q<HTMLButtonElement>('#wip-lists [data-act="unstage"]').disabled).toBe(true);
    q('#wip-lists [data-act="unstage"]').click();
    expect(sent('unstage')).toEqual([]);
    post({ type: 'wipBusy', on: false });
    post(stateMsg({ staged: [f('a')], unstaged: [] }));
    expect(q<HTMLButtonElement>('#wprimary').disabled).toBe(false);
    expect(q<HTMLInputElement>('#wsum').value).toBe('keep me');
  });

  it('amend: asks for HEAD, prefills an empty draft only, shows the pushed note, clears the prefill on untick', () => {
    post(stateMsg());
    selectWip();
    const box = q<HTMLInputElement>('#wamend');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent('amendInfo')).toHaveLength(1);
    post({ type: 'amendInfo', summary: 'Old subject', description: 'old body', pushed: true });
    expect(q<HTMLInputElement>('#wsum').value).toBe('Old subject');
    expect(q<HTMLTextAreaElement>('#wdesc').value).toBe('old body');
    expect(q('#wamendnote').hidden).toBe(false);
    expect(q('#wprimary').textContent).toContain('Amend Previous Commit');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(q<HTMLInputElement>('#wsum').value).toBe('');
    expect(q('#wamendnote').hidden).toBe(true);
    // a non-empty draft is not overwritten
    type(q<HTMLInputElement>('#wsum'), 'mine');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    post({ type: 'amendInfo', summary: 'Old subject', description: '', pushed: false });
    expect(q<HTMLInputElement>('#wsum').value).toBe('mine');
    q('#wsum').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    // amend commits whatever is staged, and never pushes; the Commit and Push menu is not offered
    expect(sent('commit')).toEqual([{ type: 'commit', summary: 'mine', description: '', amend: true, push: false }]);
    expect(q('#wmore').hidden).toBe(true);
  });

  it('amend is disabled on an unborn branch', () => {
    post(stateMsg({ sha: null }));
    // no commits: the WIP row is the only row
    selectWip();
    expect(q<HTMLInputElement>('#wamend').disabled).toBe(true);
  });

  it('a restored Amend draft on a branch that became unborn is unticked', async () => {
    await load({ root: '/r', draft: { summary: 's', description: '', amend: true }, view: 'tree', collapsed: [] });
    post(stateMsg({ sha: null, staged: [f('a')], unstaged: [] }));
    selectWip();
    expect(q<HTMLInputElement>('#wamend').checked).toBe(false);
    expect(q('#wprimary').textContent).toContain('Commit Changes to 1 File');
    expect((saved as { draft: { amend: boolean } }).draft.amend).toBe(false);
  });

  it('a double click, a held Cmd+Enter or Enter inside an IME composition sends at most one commit', () => {
    const st = stateMsg({ staged: [f('a')], unstaged: [f('b'), f('c')] });
    post(st);
    selectWip();
    type(q<HTMLInputElement>('#wsum'), 'once');
    q('#wprimary').click();
    q('#wprimary').click();
    q('#wsum').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(sent('commit')).toHaveLength(1);
    // view-only buttons stay usable while an action is in flight
    expect(q<HTMLButtonElement>('[data-act="view"][data-view="path"]').disabled).toBe(false);
    // the op finished but its state has not arrived yet: the old rows stay inert
    post({ type: 'wipBusy', on: true });
    post({ type: 'wipBusy', on: false });
    q('#wip-lists [data-act="stage"]').click();
    expect(sent('stage')).toEqual([]);
    post(st);
    q('#wip-lists [data-act="stage"]').click();
    q('#wip-lists [data-act="stage"]').click();
    expect(sent('stage')).toHaveLength(1);
    roundTrip(st);
    q('#wsum').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, repeat: true, bubbles: true }));
    q('#wsum').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true, bubbles: true }));
    expect(sent('commit')).toHaveLength(1);
  });

  it('a git action the extension never answers unblocks after a timeout', () => {
    vi.useFakeTimers();
    try {
      post(stateMsg());
      selectWip();
      q('#wip-lists [data-act="stage"]').click();
      expect(q<HTMLButtonElement>('#wprimary').disabled).toBe(true);
      vi.advanceTimersByTime(3000);
      expect(q<HTMLButtonElement>('#wprimary').disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('draft, view and collapsed folders are persisted with the root and restored', async () => {
    post(stateMsg({ unstaged: [f('a/b/c.ts'), f('a/d.ts')] }));
    selectWip();
    type(q<HTMLInputElement>('#wsum'), 'draft!');
    q('#wip-lists [data-key="unstaged:a"]').click();
    expect(saved).toMatchObject({ root: '/r', draft: { summary: 'draft!' }, view: 'tree', collapsed: ['unstaged:a'] });
    const s = saved;
    await load(s);
    post(stateMsg({ unstaged: [f('a/b/c.ts'), f('a/d.ts')] }));
    selectWip();
    expect(q<HTMLInputElement>('#wsum').value).toBe('draft!');
    expect(document.querySelector('#wip-lists [title="a/d.ts"]')).toBeNull(); // folder `a` stays collapsed
    // a state for another repo drops the restored draft
    await load(s);
    post({ ...stateMsg(), repo: { root: '/other', name: 'other' } });
    selectWip();
    expect(q<HTMLInputElement>('#wsum').value).toBe('');
  });

  it('Path/Tree switch and Collapse All', () => {
    post(stateMsg({ unstaged: [f('a/b/c.ts'), f('a/d.ts')] }));
    selectWip();
    expect(document.querySelector('#wip-lists .dir')).not.toBeNull();
    q('#wip-head [data-act="collapse"]').click();
    expect(document.querySelector('#wip-lists [title="a/d.ts"]')).toBeNull();
    expect(q('#wip-head [data-act="collapse"]').textContent).toBe('Expand All');
    q('#wip-head [data-act="view"][data-view="path"]').click();
    expect(document.querySelector('#wip-lists .dir')).toBeNull();
    expect(document.querySelector('#wip-lists [title="a/d.ts"]')).not.toBeNull();
  });

  it('leaving the WIP row and coming back rebuilds the box from the draft', () => {
    post(stateMsg());
    selectWip();
    type(q<HTMLInputElement>('#wsum'), 'kept');
    q('.gr[data-sha="' + SHA + '"]').click();
    expect(document.querySelector('#wsum')).toBeNull();
    selectWip();
    expect(q<HTMLInputElement>('#wsum').value).toBe('kept');
  });
});
