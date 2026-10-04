import { describe, expect, it } from 'vitest';
import type { Commit, Refs } from '../src/git/types';
import { ciMatcher, esc, fmtAgo, fmtAgoLong, jiraUrl, parseSubject, splitPath } from '../webview/format';
import { layout, visibleRows } from '../webview/layout';
import { commitDetailsHtml, keepSet, pillsHtml, refsBySha, rowHtml, subjectHtml, wipDetailsHtml, type RowEnv } from '../webview/render';
import { asFileChange, asFileStat, graphHtml, isAllowedUrl, isSafeRelPath, parseFromWebview, shaFromArg } from '../src/graph/validate';

const SHA = 'a'.repeat(40);
const commit = (o: Partial<Commit> = {}): Commit => ({ sha: SHA, parents: [], author: 'Ann <b>', email: 'a@x', time: 1000, subject: 'P7-4040 [ FIX ] <img src=x onerror=alert(1)>', body: 'line "1"', ...o });
const JIRA = { P7: 'https://jira.pilot-gps.com/browse/' };

describe('format', () => {
  it('escapes HTML', () => expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;'));
  it('formats relative time', () => {
    expect([0, 5, 59, 60, 1439, 1440, 60 * 24 * 90, 60 * 24 * 800].map(fmtAgo)).toEqual(['now', '5m', '59m', '1h', '24h', '1d', '3mo', '2y']);
    expect([0, 1, 5, 90, 1500].map(fmtAgoLong)).toEqual(['just now', '1 minute ago', '5 minutes ago', '2 hours ago', '1 day ago']);
  });
  it('parses key and kind like the prototype', () => {
    expect(parseSubject('P7-4040 [ FIX ] crash')).toMatchObject({ key: 'P7-4040', project: 'P7', numeric: true, kind: 'FIX', rest: 'crash' });
    expect(parseSubject('fix things')).toMatchObject({ key: '', kind: '', rest: 'fix things' });
    expect(parseSubject('GARM-abc text')).toMatchObject({ key: 'GARM-abc', numeric: false });
  });
  it('links only numeric ids of configured projects', () => {
    expect(jiraUrl(parseSubject('P7-4040 x'), JIRA)).toBe('https://jira.pilot-gps.com/browse/P7-4040');
    expect(jiraUrl(parseSubject('ZZ-1 x'), JIRA)).toBeUndefined();
    expect(jiraUrl(parseSubject('P7-abc x'), JIRA)).toBeUndefined();
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
    locals: [{ name: 'x', sha: SHA, upstream: null, ahead: 0, behind: 0, upstreamGone: false }, { name: 'develop', sha: SHA, upstream: null, ahead: 0, behind: 0, upstreamGone: false }],
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
    expect(subjectHtml(commit().subject, JIRA, true)).toContain('data-url="https://jira.pilot-gps.com/browse/P7-4040"');
  });

  it('rows carry the webview context and escape author/subject', () => {
    const c = commit();
    const lay = layout(visibleRows([c], { hideCi: false, isCi: () => false, keep: new Set(), headSha: SHA, dirty: false }).rows);
    const env: RowEnv = { width: 20, selected: SHA, headSha: SHA, jira: JIRA, pills: refsBySha(refs, refs.head), isCi: () => false, query: 'zzz', nowMs: 2_000_000, wipCount: 0 };
    const h = rowHtml(lay.rows[0], env);
    expect(h).toContain(`data-sha="${SHA}"`);
    expect(h).toContain('data-vscode-context="{&quot;webviewSection&quot;:&quot;commit&quot;');
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

  it('wip details lists staged and unstaged with areas', () => {
    const h = wipDetailsHtml({
      staged: [{ path: 'a.ts', origPath: null, status: 'M', untracked: false }],
      unstaged: [{ path: 'dir/n.ts', origPath: null, status: 'A', untracked: true }],
    }, { branch: 'develop', sha: SHA });
    expect(h).toContain('data-area="staged"');
    expect(h).toContain('data-area="unstaged"');
    expect(h).toContain('untracked');
    expect(h).toContain('data-scm="1"');
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
      locals: [{ name: 'main', sha: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, upstreamGone: false }],
      remotes: [{ name: 'origin/main', sha: 'b'.repeat(40) }],
      tags: [{ name: 'v1', sha: 'c'.repeat(40) }],
    };
    expect([...keepSet(refsBySha(refs, refs.head), refs.head)].sort()).toEqual(['a', 'b', 'c', 'd'].map((x) => x.repeat(40)));
    expect(keepSet(new Map(), { branch: null, sha: null }).size).toBe(0);
  });
  it('urls must sit under a configured Jira base', () => {
    expect(isAllowedUrl('https://jira.pilot-gps.com/browse/P7-1', JIRA)).toBe(true);
    expect(isAllowedUrl('https://evil.example/browse/P7-1', JIRA)).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)', JIRA)).toBe(false);
    expect(isAllowedUrl('file:///etc/passwd', { X: 'file:///' })).toBe(false);
    // a base without the trailing slash must not admit userinfo or a host suffix
    const bare = { X: 'https://jira.x.com' };
    expect(isAllowedUrl('https://jira.x.com/browse/X-1', bare)).toBe(true);
    expect(isAllowedUrl('https://jira.x.com@evil.io/browse/X-1', bare)).toBe(false);
    expect(isAllowedUrl('https://jira.x.com.evil.io/browse/X-1', bare)).toBe(false);
    expect(isAllowedUrl('https://u:p@jira.pilot-gps.com/browse/P7-1', JIRA)).toBe(false);
    expect(isAllowedUrl('https://jira.pilot-gps.com/other/P7-1', JIRA)).toBe(false);
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
