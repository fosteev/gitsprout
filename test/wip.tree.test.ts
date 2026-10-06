import { describe, expect, it } from 'vitest';
import type { FileChange, Status } from '../src/git/types';
import { buildTree, dirPaths, type TreeNode } from '../webview/wipTree';
import {
  canDiscard, primaryClass, rowHtml, wipBarHtml, wipCommitHtml, wipDirKeys, wipFileCount, wipHeaderHtml, wipListsHtml, wipPrimary,
  type CommitCtx, type RowEnv,
} from '../webview/render';
import { layout, visibleRows } from '../webview/layout';

const f = (path: string, o: Partial<FileChange> = {}): FileChange => ({ path, origPath: null, status: 'M', untracked: false, ...o });
const shape = (nodes: TreeNode[]): unknown[] => nodes.map((n) => (n.kind === 'dir' ? { dir: n.label, path: n.path, children: shape(n.children) } : n.name));

describe('buildTree', () => {
  it('nests folders, sorts folders before files, keeps the list index', () => {
    const t = buildTree([f('z.txt'), f('app/widgets/b.php'), f('.DS_Store'), f('app/widgets/a.php'), f('app/lib/x.php'), f('a.txt')]);
    expect(shape(t.children)).toEqual([
      { dir: 'app', path: 'app', children: [
        { dir: 'lib', path: 'app/lib', children: ['x.php'] },
        { dir: 'widgets', path: 'app/widgets', children: ['a.php', 'b.php'] },
      ] },
      '.DS_Store', 'a.txt', 'z.txt',
    ]);
    const widgets = (t.children[0] as { children: { children: { kind: string; index?: number }[] }[] }).children[1].children;
    expect(widgets.map((n) => n.index)).toEqual([3, 1]);
  });

  it('compacts a chain of single-child folders, also at the root', () => {
    const t = buildTree([f('app/widgets/deep/a.php')]);
    expect(shape(t.children)).toEqual([{ dir: 'app/widgets/deep', path: 'app/widgets/deep', children: ['a.php'] }]);
  });

  it('does not compact a folder that also holds a file or has two folders', () => {
    const t = buildTree([f('a/b/x.ts'), f('a/y.ts'), f('c/d/e.ts'), f('c/g/h.ts')]);
    expect(shape(t.children)).toEqual([
      { dir: 'a', path: 'a', children: [{ dir: 'b', path: 'a/b', children: ['x.ts'] }, 'y.ts'] },
      { dir: 'c', path: 'c', children: [{ dir: 'd', path: 'c/d', children: ['e.ts'] }, { dir: 'g', path: 'c/g', children: ['h.ts'] }] },
    ]);
    expect(dirPaths(t)).toEqual(['a', 'a/b', 'c', 'c/d', 'c/g']);
  });

  it('keeps a nested repository as a file with its trailing slash', () => {
    expect(shape(buildTree([f('vendor/lib/', { untracked: true })]).children)).toEqual([{ dir: 'vendor', path: 'vendor', children: ['lib/'] }]);
  });

  it('the same path in both areas gives independent trees and distinct collapse keys', () => {
    const wip: Status = { staged: [f('src/a.ts')], unstaged: [f('src/a.ts')] };
    expect(wipDirKeys(wip)).toEqual(['unstaged:src', 'staged:src']);
    expect(wipFileCount(wip)).toBe(1);
  });
});

const wip: Status = {
  staged: [f('src/<b>.ts'), f('old.ts', { status: 'R', origPath: 'a "q".ts' })],
  unstaged: [f('src/<b>.ts'), f('n.txt', { status: 'A', untracked: true }), f('c.txt', { status: 'U' }), f('vendor/lib/', { status: 'A', untracked: true })],
};

describe('wip lists', () => {
  it('escapes paths and renames', () => {
    for (const view of ['tree', 'path'] as const) {
      const h = wipListsHtml(wip, view, new Set());
      expect(h).not.toContain('<b>');
      expect(h).toContain('&lt;b&gt;.ts');
      expect(h).toContain('from a &quot;q&quot;.ts');
    }
  });

  it('rows carry a WIP context: file rows their path, folder rows the folder path', () => {
    const ctx = (h: string): Record<string, unknown>[] => [...h.matchAll(/data-vscode-context="([^"]*)"/g)]
      .map((m) => JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&')));
    const w: Status = { staged: [f('src/a.ts', { origPath: 'src/old.ts', status: 'R' })], unstaged: [f('src/b.ts'), f('c.ts', { status: 'U' })] };
    const all = ctx(wipListsHtml(w, 'tree', new Set(), '/repo'));
    expect(all).toContainEqual(expect.objectContaining({ webviewSection: 'wip', root: '/repo', wipArea: 'unstaged', path: 'src', wipDir: true, wipCanDiscard: false }));
    expect(all).toContainEqual(expect.objectContaining({ wipArea: 'unstaged', path: 'src/b.ts', wipDir: false, wipCanDiscard: true }));
    expect(all).toContainEqual(expect.objectContaining({ wipArea: 'unstaged', path: 'c.ts', wipCanDiscard: false })); // conflicted: no Discard
    expect(all).toContainEqual(expect.objectContaining({ wipArea: 'staged', path: 'src/a.ts', origPath: 'src/old.ts', wipCanDiscard: false }));
    expect(all.every((c) => c.preventDefaultContextMenuItems === true)).toBe(true);
  });

  it('row actions: stage on unstaged, unstage on staged, no discard on U or nested repos', () => {
    const h = wipListsHtml(wip, 'path', new Set());
    const unstaged = h.slice(h.indexOf('Unstaged Files'), h.indexOf('Staged Files'));
    const staged = h.slice(h.indexOf('Staged Files'));
    const row = (html: string, path: string): string => html.split('<div class="tr w"').find((r) => r.includes(`title="${path}"`)) ?? '';
    expect(row(unstaged, 'n.txt')).toContain('data-act="discard"');
    expect(row(unstaged, 'n.txt')).toContain('data-act="stage"');
    expect(row(unstaged, 'c.txt')).not.toContain('data-act="discard"');
    expect(row(unstaged, 'c.txt')).toContain('data-act="stage"');
    expect(row(unstaged, 'vendor/lib/')).not.toContain('data-act="discard"');
    expect(staged).toContain('data-act="unstage"');
    expect(staged).not.toContain('data-act="stage"');
    expect(staged).not.toContain('data-act="discard"');
    expect(canDiscard(f('x', { status: 'U' }))).toBe(false);
    expect(canDiscard(f('x/'))).toBe(false);
    expect(canDiscard(f('x'))).toBe(true);
  });

  it('Stage All / Unstage All only when the list is not empty, with the empty texts', () => {
    const none = wipListsHtml({ staged: [], unstaged: [] }, 'tree', new Set());
    expect(none).not.toContain('data-act="stageAll"');
    expect(none).not.toContain('data-act="unstageAll"');
    expect(none).toContain('No unstaged changes');
    expect(none).toContain('No staged changes');
    const onlyUnstaged = wipListsHtml({ staged: [], unstaged: [f('a')] }, 'tree', new Set());
    expect(onlyUnstaged).toContain('data-act="stageAll"');
    expect(onlyUnstaged).not.toContain('data-act="unstageAll"');
    expect(onlyUnstaged).toContain('Stage files to include them in the commit');
  });

  it('collapsed sections and folders hide their rows; markup has no style attributes', () => {
    const w: Status = { staged: [], unstaged: [f('a/b/c.ts'), f('a/d.ts')] };
    expect(wipListsHtml(w, 'tree', new Set(['unstaged:a']))).not.toContain('c.ts');
    expect(wipListsHtml(w, 'tree', new Set(['sec:unstaged']))).not.toContain('d.ts');
    for (const h of [wipListsHtml(wip, 'tree', new Set()), wipCommitHtml({ summary: 'x', description: 'y', amend: false }, ctx())]) expect(h).not.toMatch(/\sstyle=/);
  });

  it('header and bar', () => {
    expect(wipHeaderHtml(1, 'a<b')).toContain('1 file change on <span class="brp">a&lt;b</span>');
    expect(wipHeaderHtml(3, 'x')).toContain('3 file changes');
    expect(wipBarHtml('tree', true, true)).toContain('Collapse All');
    expect(wipBarHtml('tree', true, false)).toContain('Expand All');
    expect(wipBarHtml('path', true, true)).not.toContain('Collapse');
    expect(wipBarHtml('tree', false, true)).not.toContain('Collapse');
  });
});

const ctx = (o: Partial<CommitCtx> = {}): CommitCtx => ({ staged: 0, unborn: false, busy: false, headPushed: false, error: '', ...o });

describe('wip commit box', () => {
  it('primary button per state', () => {
    expect(wipPrimary(false, 0)).toEqual({ kind: 'stage', label: 'Stage Changes to Commit', menu: false });
    expect(wipPrimary(false, 1)).toEqual({ kind: 'commit', label: 'Commit Changes to 1 File', menu: true });
    expect(wipPrimary(false, 3)).toEqual({ kind: 'commit', label: 'Commit Changes to 3 Files', menu: true });
    expect(wipPrimary(true, 3)).toEqual({ kind: 'amend', label: 'Amend Previous Commit', menu: false });
    expect(primaryClass(wipPrimary(false, 0))).toBe('vbtn stage');
  });

  it('renders counter, amend state, note, error, menu visibility', () => {
    const h = wipCommitHtml({ summary: 'a'.repeat(80), description: '', amend: false }, ctx({ staged: 2 }));
    expect(h).toContain('class="cnt over"');
    expect(h).toContain('>-8<');
    expect(h).toContain('Commit Changes to 2 Files');
    expect(h).toMatch(/id="wmore"[^>]*aria-label="More commit actions">/);
    const amend = wipCommitHtml({ summary: 'x', description: '', amend: true }, ctx({ staged: 2, headPushed: true, error: 'Enter a commit summary.' }));
    expect(amend).toContain('Amend Previous Commit');
    expect(amend).toMatch(/id="wmore" data-act="menu" aria-label="More commit actions" hidden/);
    expect(amend).toContain('id="wamendnote">HEAD is already pushed');
    expect(amend).toContain('class="cbox bad"');
    expect(amend).toContain('checked');
    expect(wipCommitHtml({ summary: '', description: '', amend: false }, ctx({ unborn: true }))).toMatch(/id="wamend" disabled/);
    expect(wipCommitHtml({ summary: '', description: '', amend: false }, ctx({ busy: true }))).toMatch(/id="wprimary" data-act="primary" disabled/);
  });

  it('escapes the draft', () => {
    const h = wipCommitHtml({ summary: '"><img src=x>', description: '</textarea><b>', amend: false }, ctx());
    expect(h).not.toContain('<img');
    expect(h).not.toContain('<b>');
  });
});

describe('wip row label', () => {
  it('shows the draft summary or // WIP, and the file count', () => {
    const lay = layout(visibleRows([], { hideCi: false, isCi: () => false, keep: new Set(), headSha: null, dirty: true }).rows);
    const env: RowEnv = { root: '/r', width: 20, selected: null, headSha: null, jira: {}, pills: new Map(), isCi: () => false, query: '', nowMs: 0, wipCount: 1, wipSummary: '', worktrees: [] };
    expect(rowHtml(lay.rows[0], env)).toContain('<span class="wip">// WIP</span><span class="kind">1 file</span>');
    expect(rowHtml(lay.rows[0], { ...env, wipCount: 3, wipSummary: ' Fix <x> ' })).toContain('<span class="wip">Fix &lt;x&gt;</span><span class="kind">3 files</span>');
  });
});
