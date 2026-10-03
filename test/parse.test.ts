import { describe, expect, it } from 'vitest';
import {
  mergeFileStats, parseLog, parseNameStatusZ, parseNumstatZ, parseRefs, parseStashList, parseStatus, parseStatusSummary, parseTrack,
} from '../src/git/parse';
import { classify, gitEnv, lastLine } from '../src/git/run';

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
