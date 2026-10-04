// @vitest-environment happy-dom
// Smoke test of the inline diff in webview/main.ts (roadmap-inline-diff, decision 6).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange, FilePatch, FileStat } from '../src/git/types';
import type { FromWebview, ToWebview } from '../src/graph/protocol';

const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const f = (path: string, o: Partial<FileChange> = {}): FileChange => ({ path, origPath: null, status: 'M', untracked: false, ...o });
const stat = (path: string): FileStat => ({ path, origPath: null, status: 'M', add: 1, del: 1 });
const FILES = [stat('src/a.ts'), stat('src/b.ts'), stat('c.txt')];
const PATCH: FilePatch = {
  binary: false, truncated: false,
  hunks: [{ header: '@@ -1,2 +1,2 @@', oldStart: 1, newStart: 1, lines: [
    { kind: ' ', text: 'keep', old: 1, new: 1 }, { kind: '-', text: 'old', old: 2, new: null }, { kind: '+', text: 'new', old: null, new: 2 },
  ] }],
};

type StateMsg = Extract<ToWebview, { type: 'state' }>;
const stateMsg = (o: { staged?: FileChange[]; unstaged?: FileChange[]; root?: string; wip?: boolean } = {}): StateMsg => ({
  type: 'state', repo: { root: o.root ?? '/r', name: 'r' }, multiRepo: false,
  head: { branch: 'main', sha: SHA },
  commits: [
    { sha: SHA, parents: [PARENT], author: 'A', email: 'a@x', time: 1, subject: 'second', body: '' },
    { sha: PARENT, parents: [], author: 'A', email: 'a@x', time: 0, subject: 'first', body: '' },
  ],
  refs: { head: { branch: 'main', sha: SHA }, locals: [], remotes: [], tags: [] },
  wip: o.wip === false ? null : { staged: o.staged ?? [], unstaged: o.unstaged ?? [f('w1.ts'), f('w2.ts')] },
  settings: { ciPattern: '', hideCi: false, jira: {}, logLimit: 1000 },
});

let posted: FromWebview[];
let saved: unknown;
const post = (m: ToWebview): void => { window.dispatchEvent(new MessageEvent('message', { data: m })); };
const q = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const sent = <T extends FromWebview['type']>(type: T): Extract<FromWebview, { type: T }>[] => posted.filter((m) => m.type === type) as Extract<FromWebview, { type: T }>[];
const lastReq = (): number => (posted.filter((m) => m.type === 'diffCommitFile' || m.type === 'diffWipFile').pop() as { req: number }).req;
const key = (k: string, target: EventTarget = document.body): void => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };

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

const shown = (): boolean => q('#dview').hidden === false && q('#list').hidden === true;
/** HEAD commit selected with its files loaded. */
function commitReady(): void {
  post(stateMsg());
  post({ type: 'details', sha: SHA, files: FILES });
}
const fileRow = (i: number): HTMLElement => document.querySelectorAll<HTMLElement>('.tr[data-file]')[i];

beforeEach(async () => { await load(); });

describe('inline diff in the webview', () => {
  it('click on a commit file asks for its diff; the answer shows it in place of the graph', () => {
    commitReady();
    expect(q('#dview').hidden).toBe(true);
    fileRow(1).click();
    expect(sent('diffCommitFile')).toEqual([{ type: 'diffCommitFile', req: 1, sha: SHA, file: FILES[1] }]);
    expect(sent('openCommitFile')).toEqual([]);
    expect(shown()).toBe(true);
    expect(q('#dbody').textContent).toContain('Loading…');
    expect(q('#dbar').textContent).toContain('b.ts');
    expect(q('#dbar').textContent).toContain(`${PARENT.slice(0, 7)} ↔ ${SHA.slice(0, 7)}`);
    expect(fileRow(1).classList.contains('on')).toBe(true);
    post({ type: 'diff', req: 1, patch: PATCH });
    expect(q('#dbody').textContent).toContain('keep');
    expect(q('#dbody').querySelector('.dinl')).not.toBeNull();
  });

  it('a root commit is labelled "empty ↔ sha"', () => {
    post(stateMsg());
    post({ type: 'details', sha: PARENT, files: FILES });
    q('.gr[data-sha="' + PARENT + '"]').click();
    post({ type: 'details', sha: PARENT, files: FILES });
    fileRow(0).click();
    expect(q('#dbar').textContent).toContain(`empty ↔ ${PARENT.slice(0, 7)}`);
  });

  it('a stale req is ignored; an error answer is shown', () => {
    commitReady();
    fileRow(0).click();
    fileRow(1).click();
    expect(lastReq()).toBe(2);
    post({ type: 'diff', req: 1, patch: PATCH });
    expect(q('#dbody').textContent).toContain('Loading…');
    post({ type: 'diff', req: 2, error: 'git output is too large' });
    expect(q('#dbody').textContent).toContain('git output is too large');
  });

  it('Esc and the close button bring the graph back', () => {
    commitReady();
    fileRow(0).click();
    key('Escape');
    expect(shown()).toBe(false);
    expect(q('#list').hidden).toBe(false);
    expect(q('.tr.on')).toBeNull();
    fileRow(0).click();
    q<HTMLElement>('[data-dact="close"]').click();
    expect(q('#dview').hidden).toBe(true);
    // not while typing in an input
    fileRow(0).click();
    key('Escape', q('#q'));
    expect(shown()).toBe(true);
  });

  it('j / k walk the file rows without wrapping; ArrowDown is not intercepted', () => {
    commitReady();
    fileRow(0).click();
    key('k');
    expect(sent('diffCommitFile')).toHaveLength(1); // first file: no previous
    expect(q<HTMLButtonElement>('[data-dact="prev"]').disabled).toBe(true);
    key('j');
    expect(sent('diffCommitFile')[1]).toMatchObject({ file: FILES[1] });
    expect(fileRow(1).classList.contains('on')).toBe(true);
    expect(fileRow(0).classList.contains('on')).toBe(false);
    q<HTMLElement>('[data-dact="next"]').click();
    expect(sent('diffCommitFile')[2]).toMatchObject({ file: FILES[2] });
    key('j');
    expect(sent('diffCommitFile')).toHaveLength(3);
    expect(q<HTMLButtonElement>('[data-dact="next"]').disabled).toBe(true);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.body.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
  });

  it('the split chip re-renders the body and the mode is persisted', () => {
    commitReady();
    fileRow(0).click();
    post({ type: 'diff', req: 1, patch: PATCH });
    expect(q('#dbody .dinl')).not.toBeNull();
    q<HTMLElement>('[data-dact="mode"]').click();
    expect(q('#dbody .dsbs')).not.toBeNull();
    expect(q('#dbody .dinl')).toBeNull();
    expect(q('[data-dact="mode"]').getAttribute('aria-pressed')).toBe('true');
    expect((saved as { diffMode: string }).diffMode).toBe('split');
  });

  it('the persisted mode is restored; the open diff is not', async () => {
    await load({ root: '/r', diffMode: 'split' });
    commitReady();
    fileRow(0).click();
    post({ type: 'diff', req: 1, patch: PATCH });
    expect(q('#dbody .dsbs')).not.toBeNull();
    await load(saved);
    commitReady();
    expect(q('#dview').hidden).toBe(true);
  });

  it('Open in Editor posts the native-open message', () => {
    commitReady();
    fileRow(2).click();
    q<HTMLElement>('[data-dact="editor"]').click();
    expect(sent('openCommitFile')).toEqual([{ type: 'openCommitFile', sha: SHA, file: FILES[2] }]);
  });

  it('WIP: click asks for the area; follow re-requests, switches area, or closes', () => {
    post(stateMsg());
    q('.gr[data-sha="WIP"]').click();
    const row = (path: string) => q(`#wip-lists .tr.w[title="${path}"]`);
    row('w1.ts').querySelector<HTMLElement>('.tl')?.click();
    expect(sent('diffWipFile')).toEqual([{ type: 'diffWipFile', req: 1, file: f('w1.ts'), area: 'unstaged' }]);
    expect(q('#dbar').textContent).toContain('Working Tree');
    post({ type: 'diff', req: 1, patch: PATCH });
    q('#dbody').scrollTop = 40;
    // same file still unstaged: silent re-request, content stays
    post(stateMsg({ unstaged: [f('w1.ts'), f('w3.ts')] }));
    expect(sent('diffWipFile')).toHaveLength(2);
    expect(q('#dbody').textContent).toContain('keep');
    expect(row('w1.ts').classList.contains('on')).toBe(true);
    // staged now: switches area
    post(stateMsg({ staged: [f('w1.ts')], unstaged: [f('w3.ts')] }));
    expect(sent('diffWipFile')[2]).toMatchObject({ area: 'staged', file: { path: 'w1.ts' } });
    expect(q('#dbar').textContent).toContain('Staged');
    expect(shown()).toBe(true);
    // gone: closes
    post(stateMsg({ staged: [], unstaged: [f('w3.ts')] }));
    expect(shown()).toBe(false);
  });

  it('WIP: untracked label; WIP gone closes the diff', () => {
    post(stateMsg({ unstaged: [f('n.txt', { status: 'A', untracked: true })] }));
    q('.gr[data-sha="WIP"]').click();
    q('#wip-lists .tr.w .tl').click();
    expect(q('#dbar').textContent).toContain('Untracked');
    post(stateMsg({ wip: false }));
    expect(shown()).toBe(false);
  });

  it('a commit diff closes when the selection changes; reveal, another repo, error and search close it too', () => {
    commitReady();
    fileRow(0).click();
    post(stateMsg({ wip: false })); // same commit still selected: stays open
    expect(shown()).toBe(true);
    post({ type: 'reveal', sha: PARENT });
    expect(shown()).toBe(false);

    post({ type: 'details', sha: PARENT, files: FILES });
    fileRow(0).click();
    expect(shown()).toBe(true);
    post(stateMsg({ root: '/other' }));
    expect(shown()).toBe(false);

    commitReady();
    post({ type: 'details', sha: SHA, files: FILES });
    fileRow(0).click();
    post({ type: 'error', message: 'nope' });
    expect(shown()).toBe(false);

    post(stateMsg());
    post({ type: 'details', sha: SHA, files: FILES });
    fileRow(0).click();
    const qEl = q<HTMLInputElement>('#q');
    qEl.value = 'sec';
    qEl.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shown()).toBe(false);

    fileRow(0).click();
    key('Enter', qEl);
    expect(shown()).toBe(false);
  });

  it('closing restores the graph scroll position', () => {
    commitReady();
    q('#list').scrollTop = 120;
    fileRow(0).click();
    q('#list').scrollTop = 0; // a hidden element forgets it
    key('Escape');
    expect(q('#list').scrollTop).toBe(120);
  });
});
