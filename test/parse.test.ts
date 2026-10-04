import { describe, expect, it } from 'vitest';
import {
  mergeFileStats, parseLog, parseNameStatusZ, parseNumstatZ, parsePatch, parseRefs, parseStashList, parseStatus, parseStatusSummary, parseTrack,
} from '../src/git/parse';
import { classify, gitEnv, lastLine } from '../src/git/run';
import { commitMessage, splitMessage } from '../src/git/message';

const z = (...recs: string[]) => recs.join('\0') + '\0';
const H = 'a'.repeat(40);

describe('parseStatusSummary', () => {
  it('reads branch, upstream, ahead/behind and counts entries (rename = 1)', () => {
    const out = z(
      `# branch.oid ${H}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3',
      `1 .M N... 100644 100644 100644 ${H} ${H} src/a b.ts`,
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 new.ts`, 'old.ts',
      '? untracked.txt',
    );
    expect(parseStatusSummary(out)).toEqual({ branch: 'main', sha: H, upstream: 'origin/main', ahead: 2, behind: 3, changes: 3 });
  });
  it('detached and unborn', () => {
    expect(parseStatusSummary(z(`# branch.oid ${H}`, '# branch.head (detached)'))).toMatchObject({ branch: null, sha: H, upstream: null, ahead: 0, behind: 0, changes: 0 });
    expect(parseStatusSummary(z('# branch.oid (initial)', '# branch.head master', '? f'))).toMatchObject({ branch: 'master', sha: null, changes: 1 });
  });
});

describe('parseStatus', () => {
  const meta = `N... 100644 100644 100644 ${H} ${H}`;
  it('splits staged and unstaged, handles spaces in paths', () => {
    const out = z(`1 MM ${meta} dir/with space.ts`, `1 A. ${meta} added.ts`, `1 .D ${meta} gone.ts`, `1 T. ${meta} type.ts`);
    const s = parseStatus(out);
    expect(s.staged.map((f) => [f.path, f.status])).toEqual([['dir/with space.ts', 'M'], ['added.ts', 'A'], ['type.ts', 'M']]);
    expect(s.unstaged.map((f) => [f.path, f.status])).toEqual([['dir/with space.ts', 'M'], ['gone.ts', 'D']]);
  });
  it('rename keeps origPath only on the renamed side', () => {
    const out = z(`2 RM ${meta} R100 new name.ts`, 'old.ts', `2 .C ${meta} C75 cp.ts`, 'src.ts');
    const s = parseStatus(out);
    expect(s.staged).toEqual([{ path: 'new name.ts', origPath: 'old.ts', status: 'R', untracked: false }]);
    expect(s.unstaged).toEqual([
      { path: 'new name.ts', origPath: null, status: 'M', untracked: false },
      { path: 'cp.ts', origPath: 'src.ts', status: 'R', untracked: false },
    ]);
  });
  it('untracked, conflict u, ignored', () => {
    const out = z('? new file.txt', `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`, '! ignored.log');
    const s = parseStatus(out);
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([
      { path: 'new file.txt', origPath: null, status: 'A', untracked: true },
      { path: 'conflict.ts', origPath: null, status: 'U', untracked: false },
    ]);
  });
});

describe('parseTrack', () => {
  it.each([
    ['ahead 2, behind 3', { ahead: 2, behind: 3, gone: false }],
    ['ahead 4', { ahead: 4, behind: 0, gone: false }],
    ['behind 1', { ahead: 0, behind: 1, gone: false }],
    ['gone', { ahead: 0, behind: 0, gone: true }],
    ['', { ahead: 0, behind: 0, gone: false }],
  ])('%j', (text, exp) => expect(parseTrack(text)).toEqual(exp));
});

describe('parseRefs', () => {
  const rec = (...f: string[]) => f.join('\0');
  const out = [
    rec('refs/heads/main', 'm1', 'origin/main', 'ahead 1, behind 2', ''),
    rec('refs/heads/old', 'o1', 'origin/old', 'gone', ''),
    rec('refs/heads/local', 'l1', '', '', ''),
    rec('refs/remotes/origin/HEAD', 'm1', '', '', ''),
    rec('refs/remotes/origin/main', 'm1', '', '', ''),
    rec('refs/remotes/origin/feature/x', 'f1', '', '', ''),
    rec('refs/tags/v1', 't1', '', '', ''),
    rec('refs/tags/v2', 'tagobj', '', '', 'peeled2'),
  ].join('\n') + '\n';
  it('maps locals, remotes (without HEAD), tags (peeled)', () => {
    const r = parseRefs(out, { branch: 'main', sha: 'm1' });
    expect(r.head).toEqual({ branch: 'main', sha: 'm1' });
    expect(r.locals).toEqual([
      { name: 'main', sha: 'm1', upstream: 'origin/main', ahead: 1, behind: 2, upstreamGone: false },
      { name: 'old', sha: 'o1', upstream: 'origin/old', ahead: 0, behind: 0, upstreamGone: true },
      { name: 'local', sha: 'l1', upstream: null, ahead: 0, behind: 0, upstreamGone: false },
    ]);
    expect(r.remotes).toEqual([{ name: 'origin/main', sha: 'm1' }, { name: 'origin/feature/x', sha: 'f1' }]);
    expect(r.tags).toEqual([{ name: 'v1', sha: 't1' }, { name: 'v2', sha: 'peeled2' }]);
  });
  it('empty output', () => {
    expect(parseRefs('', { branch: null, sha: null })).toEqual({ head: { branch: null, sha: null }, locals: [], remotes: [], tags: [] });
  });
});

describe('parseLog', () => {
  it('parses records, merge parents, root, multi-paragraph body', () => {
    const f = (...a: string[]) => a.join('\x1f');
    const out = z(
      f('c3', 'c1 c2', 'Ann', 'a@x', '300', 'Merge', ''),
      f('c2', 'c0', 'Bob', 'b@x', '200', 'Fix bug', 'First para\n\nSecond para\n'),
      f('c0', '', 'Cy', 'c@x', '100', 'Root', ''),
    );
    expect(parseLog(out)).toEqual([
      { sha: 'c3', parents: ['c1', 'c2'], author: 'Ann', email: 'a@x', time: 300, subject: 'Merge', body: '' },
      { sha: 'c2', parents: ['c0'], author: 'Bob', email: 'b@x', time: 200, subject: 'Fix bug', body: 'First para\n\nSecond para' },
      { sha: 'c0', parents: [], author: 'Cy', email: 'c@x', time: 100, subject: 'Root', body: '' },
    ]);
  });
  it('empty', () => expect(parseLog('')).toEqual([]));
  it('keeps body indentation', () => {
    const out = z(['c1', '', 'A', 'a@x', '1', 'S', '    indented code\n'].join('\x1f'));
    expect(parseLog(out)[0].body).toBe('    indented code');
  });
});

describe('name-status / numstat', () => {
  it('parses name-status with rename and copy', () => {
    expect(parseNameStatusZ(z('M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R087', 'old.ts', 'new.ts', 'T', 't.ts'))).toEqual([
      { path: 'a.ts', origPath: null, status: 'M' },
      { path: 'b.ts', origPath: null, status: 'A' },
      { path: 'c.ts', origPath: null, status: 'D' },
      { path: 'new.ts', origPath: 'old.ts', status: 'R' },
      { path: 't.ts', origPath: null, status: 'M' },
    ]);
  });
  it('parses numstat with rename and binary', () => {
    const out = '3\t1\ta.ts\0' + '-\t-\timg.png\0' + '0\t0\t\0old.ts\0new.ts\0';
    expect(parseNumstatZ(out)).toEqual([
      { path: 'a.ts', origPath: null, add: 3, del: 1 },
      { path: 'img.png', origPath: null, add: null, del: null },
      { path: 'new.ts', origPath: 'old.ts', add: 0, del: 0 },
    ]);
  });
  it('mergeFileStats joins by path', () => {
    const names = parseNameStatusZ(z('M', 'a.ts', 'R100', 'old.ts', 'new.ts'));
    const nums = parseNumstatZ('3\t1\ta.ts\0' + '0\t0\t\0old.ts\0new.ts\0');
    expect(mergeFileStats(names, nums)).toEqual([
      { path: 'a.ts', origPath: null, status: 'M', add: 3, del: 1 },
      { path: 'new.ts', origPath: 'old.ts', status: 'R', add: 0, del: 0 },
    ]);
    expect(mergeFileStats(names, [])[0]).toMatchObject({ add: null, del: null });
  });
  it('empty', () => {
    expect(parseNameStatusZ('')).toEqual([]);
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('parseStashList', () => {
  it('parses index, sha, message', () => {
    const out = z('stash@{0}\x1fs0\x1fWIP on main: abc msg', 'stash@{1}\x1fs1\x1fOn main: custom message');
    expect(parseStashList(out)).toEqual([
      { index: 0, sha: 's0', message: 'WIP on main: abc msg' },
      { index: 1, sha: 's1', message: 'On main: custom message' },
    ]);
    expect(parseStashList('')).toEqual([]);
  });
});

describe('run helpers', () => {
  it('classify: Auth variants', () => {
    expect(classify('git@host: Permission denied (publickey,password).\nfatal: Could not read from remote repository.')).toBe('Auth');
    expect(classify('Host key verification failed.')).toBe('Auth');
    expect(classify("fatal: Authentication failed for 'https://x'")).toBe('Auth');
    expect(classify('fatal: not a git repository (or any of the parent directories): .git')).toBe('NotARepo');
    expect(classify('error: failed to push some refs')).toBe('Other');
  });
  it('lastLine prefers fatal/error over hints', () => {
    expect(lastLine("error: failed to push some refs to 'x'\nhint: Updates were rejected\nhint: see git push --help\n")).toBe("error: failed to push some refs to 'x'");
    expect(lastLine('Already up to date.\n')).toBe('Already up to date.');
    expect(lastLine('hint: only hints\n')).toBe('hint: only hints');
  });
  it('gitEnv strips repo-relocating variables', () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/elsewhere/.git';
    try {
      const env = gitEnv(true);
      expect(env.GIT_DIR).toBeUndefined();
      expect(env).toMatchObject({ LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
      expect(gitEnv(false).GIT_OPTIONAL_LOCKS).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
  });
});

describe('commit message helpers', () => {
  it('commitMessage: trims, joins with a blank line, normalizes CRLF, null for an empty summary', () => {
    expect(commitMessage('  Fix it  ', '')).toBe('Fix it');
    expect(commitMessage('Fix it', '  \n ')).toBe('Fix it');
    expect(commitMessage('Fix it   \r\n', '\r\nWhy:\r\n- a  \r\n- b\r\n\r\n')).toBe('Fix it\n\nWhy:\n- a  \n- b');
    expect(commitMessage('Fix', 'para one\n\npara two')).toBe('Fix\n\npara one\n\npara two');
    expect(commitMessage('', 'description only')).toBeNull();
    expect(commitMessage('  \t ', 'x')).toBeNull();
  });
  it('splitMessage: first paragraph is the summary, the rest the description', () => {
    expect(splitMessage('Subject\n')).toEqual({ summary: 'Subject', description: '' });
    expect(splitMessage('Subject\n\nBody line\n')).toEqual({ summary: 'Subject', description: 'Body line' });
    expect(splitMessage('Subject  \r\n\r\nBody  \r\n\r\nSecond para\r\n\r\n')).toEqual({ summary: 'Subject', description: 'Body  \n\nSecond para' });
    expect(splitMessage('S\n  \nBody')).toEqual({ summary: 'S', description: 'Body' }); // whitespace-only line separates
    expect(splitMessage('')).toEqual({ summary: '', description: '' });
    expect(splitMessage('\n\nOnly after blanks\n\nbody')).toEqual({ summary: 'Only after blanks', description: 'body' });
    // a multi-line first paragraph: only its first line is the summary, the rest moves to the description
    expect(splitMessage('L1\nL2\n\nBody')).toEqual({ summary: 'L1', description: 'L2\n\nBody' });
  });
  it('round trip: commitMessage(splitMessage(x)) is x for a tidy message', () => {
    const m = 'Add thing\n\nFirst paragraph.\n\nSecond paragraph\n- item';
    const { summary, description } = splitMessage(m);
    expect(commitMessage(summary, description)).toBe(m);
  });
});

describe('parsePatch', () => {
  const lines = (...l: string[]) => l.join('\n') + '\n';
  it('multi-hunk modify with numbering and section text', () => {
    const p = parsePatch(lines(
      'diff --git a/f.ts b/f.ts', 'index 111..222 100644', '--- a/f.ts', '+++ b/f.ts',
      '@@ -1,3 +1,3 @@ function foo() {', ' a', '-b', '+B', ' c',
      '@@ -10,2 +10,3 @@', ' x', '+y', ' z',
    ));
    expect(p.binary).toBe(false);
    expect(p.truncated).toBe(false);
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]).toMatchObject({ header: '@@ -1,3 +1,3 @@ function foo() {', oldStart: 1, newStart: 1 });
    expect(p.hunks[0].lines).toEqual([
      { kind: ' ', text: 'a', old: 1, new: 1 },
      { kind: '-', text: 'b', old: 2, new: null },
      { kind: '+', text: 'B', old: null, new: 2 },
      { kind: ' ', text: 'c', old: 3, new: 3 },
    ]);
    expect(p.hunks[1]).toMatchObject({ oldStart: 10, newStart: 10 });
    expect(p.hunks[1].lines.map((l) => [l.kind, l.old, l.new])).toEqual([[' ', 10, 10], ['+', null, 11], [' ', 11, 12]]);
  });
  it('added file', () => {
    const p = parsePatch(lines('diff --git a/n b/n', 'new file mode 100644', 'index 0000000..111 100644', '--- /dev/null', '+++ b/n', '@@ -0,0 +1,2 @@', '+one', '+two'));
    expect(p.hunks[0]).toMatchObject({ oldStart: 0, newStart: 1 });
    expect(p.hunks[0].lines.map((l) => [l.kind, l.text, l.old, l.new])).toEqual([['+', 'one', null, 1], ['+', 'two', null, 2]]);
  });
  it('deleted file', () => {
    const p = parsePatch(lines('diff --git a/d b/d', 'deleted file mode 100644', '--- a/d', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two'));
    expect(p.hunks[0].lines.map((l) => [l.kind, l.old, l.new])).toEqual([['-', 1, null], ['-', 2, null]]);
  });
  it('rename-only has no hunks', () => {
    const p = parsePatch(lines('diff --git a/a b/b', 'similarity index 100%', 'rename from a', 'rename to b'));
    expect(p).toEqual({ binary: false, hunks: [], truncated: false });
  });
  it('binary', () => {
    expect(parsePatch(lines('diff --git a/x.png b/x.png', 'index 1..2 100644', 'Binary files a/x.png and b/x.png differ'))).toMatchObject({ binary: true, hunks: [] });
    expect(parsePatch(lines('diff --git a/x b/x', 'index 1..2 100644', 'GIT binary patch', 'literal 3', 'xyz'))).toMatchObject({ binary: true, hunks: [] });
  });
  it('skips "\\ No newline at end of file"', () => {
    const p = parsePatch(lines('@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file'));
    expect(p.hunks[0].lines.map((l) => l.kind + l.text)).toEqual(['-a', '+b']);
  });
  it('strips a trailing CR', () => {
    const p = parsePatch('@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
    expect(p.hunks[0].lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
  it('omitted counts mean 1; empty line is context', () => {
    const p = parsePatch('@@ -5 +7 @@\n-a\n+b\n\n c\n');
    expect(p.hunks[0]).toMatchObject({ header: '@@ -5 +7 @@', oldStart: 5, newStart: 7 });
    expect(p.hunks[0].lines[2]).toEqual({ kind: ' ', text: '', old: 6, new: 8 });
    expect(p.hunks[0].lines[3]).toEqual({ kind: ' ', text: 'c', old: 7, new: 9 });
  });
  it('truncates after maxLines', () => {
    const body = Array.from({ length: 10 }, (_, i) => `+l${i}`);
    const p = parsePatch(lines('@@ -0,0 +1,10 @@', ...body), 4);
    expect(p.truncated).toBe(true);
    expect(p.hunks[0].lines).toHaveLength(4);
    expect(parsePatch(lines('@@ -0,0 +1,10 @@', ...body), 10).truncated).toBe(false);
  });
});
