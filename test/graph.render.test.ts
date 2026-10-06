import { describe, expect, it } from 'vitest';
import type { Commit, FilePatch, Refs } from '../src/git/types';
import { ciMatcher, esc, fmtAgo, fmtAgoLong, jiraUrl, parseSubject, splitPath } from '../webview/format';
import { layout, visibleRows } from '../webview/layout';
import { commitDetailsHtml, diffBarHtml, diffBodyHtml, keepSet, pillsHtml, refsBySha, rowHtml, subjectHtml, type RowEnv } from '../webview/render';
import { asFileChange, asFileStat, graphHtml, isAllowedUrl, isSafeRelPath, parseFromWebview, shaFromArg, wipContextFromArg } from '../src/graph/validate';

const SHA = 'a'.repeat(40);
const commit = (o: Partial<Commit> = {}): Commit => ({ sha: SHA, parents: [], author: 'Ann <b>', email: 'a@x', time: 1000, subject: 'X7-4040 [ FIX ] <img src=x onerror=alert(1)>', body: 'line "1"', ...o });
const JIRA = { X7: 'https://jira.example.com/browse/' };

describe('format', () => {
  it('escapes HTML', () => expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;'));
  it('formats relative time', () => {
    expect([0, 5, 59, 60, 1439, 1440, 60 * 24 * 90, 60 * 24 * 800].map(fmtAgo)).toEqual(['now', '5m', '59m', '1h', '24h', '1d', '3mo', '2y']);
    expect([0, 1, 5, 90, 1500].map(fmtAgoLong)).toEqual(['just now', '1 minute ago', '5 minutes ago', '2 hours ago', '1 day ago']);
  });
  it('parses key and kind like the prototype', () => {
    expect(parseSubject('X7-4040 [ FIX ] crash')).toMatchObject({ key: 'X7-4040', project: 'X7', numeric: true, kind: 'FIX', rest: 'crash' });
    expect(parseSubject('fix things')).toMatchObject({ key: '', kind: '', rest: 'fix things' });
    expect(parseSubject('OPS-abc text')).toMatchObject({ key: 'OPS-abc', numeric: false });
  });
  it('links only numeric ids of configured projects', () => {
    expect(jiraUrl(parseSubject('X7-4040 x'), JIRA)).toBe('https://jira.example.com/browse/X7-4040');
    expect(jiraUrl(parseSubject('ZZ-1 x'), JIRA)).toBeUndefined();
    expect(jiraUrl(parseSubject('X7-abc x'), JIRA)).toBeUndefined();
  });
  it('ciMatcher tolerates bad patterns', () => {
    expect(ciMatcher('^AutoBuild$')('AutoBuild')).toBe(true);
    expect(ciMatcher('^AutoBuild$')('AutoBuild 2')).toBe(false);
    expect(ciMatcher('(')('x')).toBe(false);
    expect(ciMatcher('')('x')).toBe(false);
  });
  it('splits paths', () => expect(splitPath('a/b/c.ts')).toEqual(['a/b', 'c.ts']));
});

describe('render', () => {
  const refs: Refs = {
    head: { branch: 'develop', sha: SHA },
    locals: [{ name: 'x', sha: SHA, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null }, { name: 'develop', sha: SHA, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null }],
    remotes: [{ name: 'origin/develop', sha: SHA }], tags: [{ name: 'v1', sha: SHA }],
  };

  it('puts the checked-out branch first and escapes names', () => {
    const pills = refsBySha(refs, refs.head).get(SHA)!;
    expect(pills.map((p) => p.name)).toEqual(['develop', 'x', 'origin/develop', 'v1']);
    expect(pillsHtml([{ kind: 'tag', name: '<b>', head: false }], 0)).not.toContain('<b>');
  });

  it('escapes the subject and links Jira only when asked', () => {
    const plain = subjectHtml(commit().subject, JIRA, false);
    expect(plain).not.toContain('<img');
    expect(plain).not.toContain('data-url');
    expect(subjectHtml(commit().subject, JIRA, true)).toContain('data-url="https://jira.example.com/browse/X7-4040"');
  });

  it('rows carry the webview context and escape author/subject', () => {
    const c = commit();
    const lay = layout(visibleRows([c], { hideCi: false, isCi: () => false, keep: new Set(), headSha: SHA, dirty: false }).rows);
    const env: RowEnv = { root: '/work/repo', width: 20, selected: SHA, headSha: SHA, jira: JIRA, pills: refsBySha(refs, refs.head), isCi: () => false, query: 'zzz', nowMs: 2_000_000, wipCount: 0, wipSummary: '' };
    const h = rowHtml(lay.rows[0], env);
    expect(h).toContain(`data-sha="${SHA}"`);
    expect(h).toContain('data-vscode-context="{&quot;webviewSection&quot;:&quot;commit&quot;');
    expect(h).toContain('root&quot;:&quot;/work/repo&quot;');
    expect(h).toContain('preventDefaultContextMenuItems&quot;:true');
    expect(h).toContain(' on');
    expect(h).toContain(' dim');
    expect(h).not.toContain('<b>');
    expect(h).not.toContain('<img');
  });

  it('details: merge note, loading, error, files with stats', () => {
    const env = { jira: JIRA, pills: new Map(), nowMs: 5_000_000, known: new Set(['b'.repeat(40)]) };
    const m = commit({ parents: ['b'.repeat(40), 'c'.repeat(40)] });
    const h = commitDetailsHtml(m, [], env);
    expect(h).toContain('MERGE COMMIT');
    expect(h).toContain('data-select="' + 'b'.repeat(40) + '"');
    expect(commitDetailsHtml(m, 'loading', env)).toContain('Loading files');
    expect(commitDetailsHtml(m, { error: '<x>' }, env)).toContain('&lt;x&gt;');
    const f = commitDetailsHtml(commit(), [{ path: 'a/b.ts', origPath: 'a/old.ts', status: 'R', add: 3, del: 1 }, { path: 'img.png', origPath: null, status: 'A', add: null, del: null }], env);
    expect(f).toContain('+3');
    expect(f).toContain('from a/old.ts');
    expect(f).toContain('data-file="1" data-area="commit"');
  });
});

describe('webview message validation', () => {
  it('accepts well-formed messages and rejects the rest', () => {
    expect(parseFromWebview({ type: 'select', sha: SHA })).toEqual({ type: 'select', sha: SHA });
    expect(parseFromWebview({ type: 'select', sha: '--upload-pack=x' })).toBeUndefined();
    expect(parseFromWebview({ type: 'toggleCi', hideCi: 'yes' })).toBeUndefined();
    expect(parseFromWebview({ type: 'nope' })).toBeUndefined();
    expect(parseFromWebview(null)).toBeUndefined();
    expect(parseFromWebview({ type: 'openWipFile', area: 'staged', file: { path: '../../etc/passwd', origPath: null, status: 'M', untracked: false } })).toBeUndefined();
    expect(parseFromWebview({ type: 'openWipFile', area: 'staged', file: { path: 'a.ts', origPath: null, status: 'M', untracked: false } })).toMatchObject({ type: 'openWipFile', area: 'staged' });
    expect(parseFromWebview({ type: 'openCommitFile', sha: SHA, file: { path: 'a.ts', origPath: null, status: 'M', add: 1, del: 2 } })).toMatchObject({ type: 'openCommitFile' });
  });
  it('safe paths', () => {
    expect([isSafeRelPath('a/b'), isSafeRelPath('/a'), isSafeRelPath('a/../b'), isSafeRelPath('..'), isSafeRelPath(''), isSafeRelPath('a..b')]).toEqual([true, false, false, false, false, true]);
    expect(asFileStat({ path: 'a', origPath: null, status: 'Z', add: 0, del: 0 })).toBeUndefined();
    expect(asFileChange({ path: 'a', origPath: null, status: 'M', untracked: 1 })).toBeUndefined();
  });
  it('keepSet: every ref tip plus a detached HEAD commit', () => {
    const refs: Refs = {
      head: { branch: null, sha: 'd'.repeat(40) },
      locals: [{ name: 'main', sha: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null }],
      remotes: [{ name: 'origin/main', sha: 'b'.repeat(40) }],
      tags: [{ name: 'v1', sha: 'c'.repeat(40) }],
    };
    expect([...keepSet(refsBySha(refs, refs.head), refs.head)].sort()).toEqual(['a', 'b', 'c', 'd'].map((x) => x.repeat(40)));
    expect(keepSet(new Map(), { branch: null, sha: null }).size).toBe(0);
  });
  it('urls must sit under a configured Jira base', () => {
    expect(isAllowedUrl('https://jira.example.com/browse/X7-1', JIRA)).toBe(true);
    expect(isAllowedUrl('https://evil.example/browse/X7-1', JIRA)).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)', JIRA)).toBe(false);
    expect(isAllowedUrl('file:///etc/passwd', { X: 'file:///' })).toBe(false);
    // a base without the trailing slash must not admit userinfo or a host suffix
    const bare = { X: 'https://jira.x.com' };
    expect(isAllowedUrl('https://jira.x.com/browse/X-1', bare)).toBe(true);
    expect(isAllowedUrl('https://jira.x.com@evil.io/browse/X-1', bare)).toBe(false);
    expect(isAllowedUrl('https://jira.x.com.evil.io/browse/X-1', bare)).toBe(false);
    expect(isAllowedUrl('https://u:p@jira.example.com/browse/X7-1', JIRA)).toBe(false);
    expect(isAllowedUrl('https://jira.example.com/other/X7-1', JIRA)).toBe(false);
  });
  it('wipContextFromArg takes a WIP row context only, with safe paths', () => {
    const c = { webviewSection: 'wip', root: '/r', wipArea: 'staged', path: 'src', origPath: null, wipDir: true, wipCanDiscard: false };
    expect(wipContextFromArg(c)).toEqual({ root: '/r', area: 'staged', path: 'src', origPath: null });
    expect(wipContextFromArg({ ...c, origPath: 'old.ts' })?.origPath).toBe('old.ts');
    expect(wipContextFromArg({ ...c, webviewSection: 'commit' })).toBeUndefined();
    expect(wipContextFromArg({ ...c, wipArea: 'both' })).toBeUndefined();
    expect(wipContextFromArg({ ...c, path: '../x' })).toBeUndefined();
    expect(wipContextFromArg({ ...c, origPath: '/etc/passwd' })).toBeUndefined();
    expect(wipContextFromArg({ ...c, root: '' })).toBeUndefined();
    expect(wipContextFromArg(undefined)).toBeUndefined();
  });

  it('shaFromArg takes the row context or a string', () => {
    expect(shaFromArg({ sha: SHA, webviewSection: 'commit' })).toBe(SHA);
    expect(shaFromArg(SHA)).toBe(SHA);
    expect(shaFromArg(undefined)).toBeUndefined();
    expect(shaFromArg({ sha: 'zz' })).toBeUndefined();
  });
  it('html has a nonce CSP without inline allowances', () => {
    const h = graphHtml({ cspSource: 'vscode-webview://x', nonce: 'N0nce', scriptUri: 'vscode-webview://x/webview.js', styleUri: 'vscode-webview://x/webview.css' });
    expect(h).toContain("script-src 'nonce-N0nce'");
    expect(h).toContain('<script nonce="N0nce"');
    expect(h).not.toContain('unsafe-inline');
    expect(h).toContain("default-src 'none'");
  });
});

describe('diff rendering', () => {
  const line = (kind: ' ' | '+' | '-', text: string, old: number | null, nw: number | null) => ({ kind, text, old, new: nw });
  const patch = (lines: ReturnType<typeof line>[], extra: Partial<FilePatch> = {}): FilePatch =>
    ({ binary: false, truncated: false, hunks: [{ header: '@@ -1,3 +1,3 @@ fn <b>', oldStart: 1, newStart: 1, lines }], ...extra });
  const mixed = patch([line(' ', 'a', 1, 1), line('-', 'old1', 2, null), line('-', 'old2', 3, null), line('+', 'new1', null, 2), line(' ', 'z', 4, 3)]);
  const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

  it('inline: fold row, numbers, signs, classes', () => {
    const html = diffBodyHtml(mixed, 'inline');
    expect(html).toContain('dinl');
    expect(html).toContain('<span class="dfold">@@ -1,3 +1,3 @@ fn &lt;b&gt;</span>');
    expect(html).toContain('<span class="dn rem">2</span><span class="dn rem"></span><span class="dg rem">-</span><span class="dc rem">old1</span>');
    expect(html).toContain('<span class="dn ins"></span><span class="dn ins">2</span><span class="dg ins">+</span><span class="dc ins">new1</span>');
    expect(html).toContain('<span class="dn">1</span><span class="dn">1</span><span class="dg"></span><span class="dc">a</span>');
  });

  it('split: context on both sides, runs zipped, the shorter side padded with fill', () => {
    const html = diffBodyHtml(mixed, 'split');
    expect(html).toContain('dsbs');
    expect(html).toContain('<span class="dn">1</span><span class="dc">a</span><span class="dn dr">1</span><span class="dc">a</span>');
    // old1 | new1 on one row, old2 | fill on the next
    expect(html).toContain('<span class="dc rem">old1</span><span class="dn ins dr">2</span><span class="dc ins">new1</span>');
    expect(html).toContain('<span class="dc rem">old2</span><span class="dn fill dr"></span><span class="dc fill"></span>');
    expect(count(html, /fill/g)).toBe(2);
  });

  it('split: additions alone get a filled left side, removals alone a filled right side', () => {
    const add = diffBodyHtml(patch([line('+', 'x', null, 1)]), 'split');
    expect(add).toContain('<span class="dn fill"></span><span class="dc fill"></span><span class="dn ins dr">1</span><span class="dc ins">x</span>');
    const del = diffBodyHtml(patch([line('-', 'y', 1, null)]), 'split');
    expect(del).toContain('<span class="dn rem">1</span><span class="dc rem">y</span><span class="dn fill dr"></span><span class="dc fill"></span>');
  });

  it('escapes file content in both modes', () => {
    const p = patch([line('+', '<img src=x onerror=alert(1)> & "q"', null, 1)]);
    for (const mode of ['inline', 'split'] as const) {
      const html = diffBodyHtml(p, mode);
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
    }
  });

  it('states: loading, error, binary, no hunks, truncated', () => {
    expect(diffBodyHtml('loading', 'inline')).toContain('Loading…');
    expect(diffBodyHtml({ error: 'boom <x>' }, 'inline')).toContain('boom &lt;x&gt;');
    expect(diffBodyHtml({ binary: true, hunks: [], truncated: false }, 'inline')).toContain('Binary file — not shown.');
    expect(diffBodyHtml({ binary: false, hunks: [], truncated: false }, 'split')).toContain('No content changes.');
    expect(diffBodyHtml(patch([line('+', 'x', null, 1)], { truncated: true }), 'inline')).toContain('Diff truncated at 10 000 lines — Open in Editor for the full diff.');
    expect(diffBodyHtml(mixed, 'inline')).not.toContain('truncated');
  });

  it('bar: path split, label, mode chip, nav state, escaping', () => {
    const bar = { status: 'M', path: 'src/<a>.ts', origPath: null, label: 'abc1234 ↔ def5678', mode: 'inline' as const, hasPrev: false, hasNext: true };
    const html = diffBarHtml(bar);
    expect(html).toContain('<span class="ddir">src/</span><b>&lt;a&gt;.ts</b>');
    expect(html).toContain('abc1234 ↔ def5678');
    expect(html).toContain('data-dact="prev" title="Previous file (k)" disabled');
    expect(html).toContain('data-dact="next" title="Next file (j)">');
    expect(html).toContain('aria-pressed="false" title="Switch to Split">Inline');
    expect(html).toContain('Open in Editor');
    expect(html).toContain('Close (Esc)');
    expect(diffBarHtml({ ...bar, mode: 'split' })).toContain('aria-pressed="true" title="Switch to Inline">Split');
  });
});
