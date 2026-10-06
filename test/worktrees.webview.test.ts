// @vitest-environment happy-dom
// Smoke test of the worktree rows, pills, card and chip in webview/main.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWebview, GraphWorktree, ToWebview } from '../src/graph/protocol';

const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const wt = (o: Partial<GraphWorktree>): GraphWorktree => ({ path: '/w/x', name: 'x', branch: null, head: null, changes: 0, current: false, main: false, ...o });
const branch = (name: string, sha: string, worktree: string | null) => ({ name, sha, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree });

const stateMsg = (worktrees: GraphWorktree[], wip = false): Extract<ToWebview, { type: 'state' }> => ({
  type: 'state', repo: { root: '/r', name: 'r' }, multiRepo: false, stashes: 0, worktrees,
  head: { branch: 'main', sha: SHA },
  commits: [
    { sha: SHA, parents: [PARENT], author: 'A', email: 'a@x', time: 1, subject: 'second', body: '' },
    { sha: PARENT, parents: [], author: 'A', email: 'a@x', time: 0, subject: 'first', body: '' },
  ],
  refs: { head: { branch: 'main', sha: SHA }, locals: [branch('main', SHA, '/r'), branch('feat', PARENT, '/w/feat')], remotes: [], tags: [] },
  wip: wip ? { staged: [], unstaged: [{ path: 'a.ts', origPath: null, status: 'M', untracked: false }] } : null,
  settings: { ciPattern: '', hideCi: false, jira: {}, logLimit: 1000 },
});
const LIST = [
  wt({ path: '/r', name: 'r', branch: 'main', head: SHA, current: true, main: true }),
  wt({ path: '/w/feat', name: 'feat', branch: 'feat', head: PARENT, changes: 3 }),
  wt({ path: '/w/quiet', name: 'quiet', branch: 'q', head: SHA, changes: 0 }),
];

let posted: FromWebview[];
let saved: unknown;
const post = (m: ToWebview): void => { window.dispatchEvent(new MessageEvent('message', { data: m })); };
const q = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const all = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];

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

beforeEach(async () => { await load(); });

describe('worktrees in the graph webview', () => {
  it('shows a WIP row only for another worktree with changes, and pills for branches elsewhere', () => {
    post(stateMsg(LIST));
    const rows = all('.gr');
    expect(rows.map((r) => r.dataset.sha)).toEqual(['WIP:/w/feat', SHA, PARENT]);
    expect(rows[0].textContent).toContain('3 uncommitted changes');
    const pills = all('.ref.other');
    expect(pills).toHaveLength(1);
    expect(pills[0].title).toBe('Checked out in worktree feat (/w/feat)');
    // our own branch, although git says its worktree is `/r`, is not marked: `current` decides
    expect(all('.ref').find((p) => p.textContent === 'main')?.classList.contains('other')).toBe(false);
  });

  it('selecting the row shows the card; its buttons post worktree messages and never the WIP panel', () => {
    post(stateMsg(LIST, true));
    expect(all('.gr').map((r) => r.dataset.sha)).toEqual(['WIP', 'WIP:/w/feat', SHA, PARENT]);
    posted.length = 0; // the first state asks for HEAD's files
    q('.gr[data-sha="WIP:/w/feat"]').click();
    expect(q('.wtcard')).not.toBeNull();
    expect(q('.wtcard').textContent).toContain('/w/feat');
    expect(q('#wsum')).toBeNull();
    expect(posted.some((m) => m.type === 'select')).toBe(false);
    for (const [action, label] of [['openGraph', 'Open Graph'], ['openWindow', 'Open in New Window'], ['terminal', 'Open Terminal']] as const) {
      const b = all('.wtcard button').find((x) => x.textContent === label)!;
      b.click();
      expect(posted.pop()).toEqual({ type: 'worktree', action, path: '/w/feat' });
    }
  });

  it('the chip hides the rows and pills, is remembered, and the selection falls back to a commit', () => {
    post(stateMsg(LIST));
    expect(q('#wt').hidden).toBe(false);
    expect(q('#wt').textContent).toBe('Worktrees · 2');
    q('.gr[data-sha="WIP:/w/feat"]').click();
    q('#wt').click();
    expect(all('.gr').map((r) => r.dataset.sha)).toEqual([SHA, PARENT]);
    expect(all('.ref.other')).toHaveLength(0);
    expect(q('#wt').getAttribute('aria-pressed')).toBe('false');
    expect(q('.wtcard')).toBeNull();
    expect((saved as { worktrees?: unknown }).worktrees).toBe(false);
    q('#wt').click();
    expect(all('.gr')).toHaveLength(3);
  });

  it('a remembered off state is applied on the first state', async () => {
    await load({ root: '/r', worktrees: false });
    post(stateMsg(LIST));
    expect(all('.gr').map((r) => r.dataset.sha)).toEqual([SHA, PARENT]);
    expect(q('#wt').getAttribute('aria-pressed')).toBe('false');
  });

  it('a repo with a single worktree has no chip and no extra rows', () => {
    post(stateMsg([LIST[0]]));
    expect(q('#wt').hidden).toBe(true);
    expect(all('.gr')).toHaveLength(2);
  });

  it('the row\'s right-click context is the worktree\'s', () => {
    post(stateMsg(LIST));
    const ctx = JSON.parse(q('.gr[data-sha="WIP:/w/feat"]').dataset.vscodeContext as string);
    expect(ctx).toMatchObject({ webviewSection: 'worktree', path: '/w/feat', root: '/r', worktreeMain: false });
  });
});
