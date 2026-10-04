import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo';
import { GitError, type FileChange } from '../src/git/types';
import { deleteDetail, errorPlan, pullMessage, pushMessage, resolveStashIndex, terminalCommand } from '../src/commands/messages';

// Everything happens in a temp dir under an isolated git environment: no global/system config, no hooks,
// no signing, no editor. A bare "origin" on disk stands in for the remote; no network.
let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_EDITOR: 'true',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-it-')));
  Object.assign(ENV, { HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig-global') });
  for (const k of Object.keys(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = ENV[k]; }
  // Running inside a git hook would point the helper `g()` at the outer repo.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) {
    if (!(k in ENV)) { savedEnv[k] = process.env[k]; ENV[k] = ''; delete process.env[k]; }
  }
  writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
});
afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function put(repo: string, file: string, content: string) {
  const p = join(repo, file);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function commit(repo: string, file: string, content: string, msg: string): string {
  put(repo, file, content);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD').trim();
}
function configure(repo: string) {
  g(repo, 'config', 'user.name', 'Test');
  g(repo, 'config', 'user.email', 'test@example.com');
  g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'config', 'core.hooksPath', join(tmp, 'no-hooks'));
}
let n = 0;
function fresh(name: string): string {
  const dir = join(tmp, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function init(name: string): string {
  const dir = fresh(name);
  g(dir, 'init', '-q', '-b', 'main');
  configure(dir);
  return dir;
}
/** origin (bare) + clones a and b, both on main tracking origin/main, one initial commit. */
function scenario() {
  const origin = fresh('origin');
  g(origin, 'init', '-q', '--bare', '-b', 'main');
  const a = init('a');
  g(a, 'remote', 'add', 'origin', origin);
  commit(a, 'README.md', 'hello\n', 'Initial commit');
  g(a, 'push', '-q', '-u', 'origin', 'main');
  const b = fresh('b');
  g(tmp, 'clone', '-q', origin, b);
  configure(b);
  return { origin, a, b, ra: new Repo(a), rb: new Repo(b) };
}
async function kind(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof GitError) return e.kind; throw e; }
  return 'no error';
}

describe('reads', () => {
  it('unborn repo', async () => {
    const dir = init('unborn');
    const r = new Repo(dir);
    expect(await r.summary()).toMatchObject({ branch: 'main', sha: null, upstream: null, changes: 0 });
    expect((await r.refs()).head).toEqual({ branch: 'main', sha: null });
    expect(await r.log(10)).toEqual([]);
    put(dir, 'f.txt', 'x');
    expect(await r.summary()).toMatchObject({ changes: 1 });
    expect((await r.status()).unstaged).toEqual([{ path: 'f.txt', origPath: null, status: 'A', untracked: true }]);
    expect(await r.show('HEAD', 'f.txt')).toBe('');
  });

  it('summary, refs, log, status, commitFiles, stashes', async () => {
    const { a, ra } = scenario();
    const c1 = g(a, 'rev-parse', 'HEAD').trim();
    put(a, 'src/old name.ts', 'line1\nline2\nline3\nline4\nline5\n');
    g(a, 'add', '-A');
    g(a, 'commit', '-q', '-m', 'Add file');
    g(a, 'mv', 'src/old name.ts', 'src/new.ts');
    writeFileSync(join(a, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    g(a, 'add', '-A');
    g(a, 'commit', '-q', '-m', 'Rename and add binary\n\nBody line 1\n\nBody line 2');
    const c3 = g(a, 'rev-parse', 'HEAD').trim();
    g(a, 'tag', 'light');
    g(a, 'tag', '-a', '-m', 'annotated', 'v1');
    g(a, 'branch', 'topic', c1);

    const refs = await ra.refs();
    expect(refs.head).toEqual({ branch: 'main', sha: c3 });
    expect(refs.locals.map((b) => b.name).sort()).toEqual(['main', 'topic']);
    expect(refs.locals.find((b) => b.name === 'main')).toMatchObject({ upstream: 'origin/main', ahead: 2, behind: 0, upstreamGone: false });
    expect(refs.remotes).toEqual([{ name: 'origin/main', sha: c1 }]);
    expect(refs.tags).toContainEqual({ name: 'v1', sha: c3 }); // peeled
    expect(refs.tags).toContainEqual({ name: 'light', sha: c3 });

    const log = await ra.log(100);
    expect(log.map((c) => c.subject)).toEqual(['Rename and add binary', 'Add file', 'Initial commit']);
    expect(log[0]).toMatchObject({ sha: c3, author: 'Test', email: 'test@example.com', body: 'Body line 1\n\nBody line 2' });
    expect(log[0].parents).toEqual([log[1].sha]);
    expect(log[2].parents).toEqual([]);
    expect((await ra.log(1)).length).toBe(1);

    const files = await ra.commitFiles(c3);
    expect(files).toContainEqual({ path: 'src/new.ts', origPath: 'src/old name.ts', status: 'R', add: 0, del: 0 });
    expect(files).toContainEqual({ path: 'bin.dat', origPath: null, status: 'A', add: null, del: null });
    expect(await ra.commitFiles(c1)).toEqual([{ path: 'README.md', origPath: null, status: 'A', add: 1, del: 0 }]); // root commit

    put(a, 'README.md', 'changed\n');
    put(a, 'staged.txt', 's');
    g(a, 'add', 'staged.txt');
    put(a, 'untracked/dir/file.txt', 'u');
    expect(await ra.summary()).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0, changes: 3 });
    const st = await ra.status();
    expect(st.staged).toEqual([{ path: 'staged.txt', origPath: null, status: 'A', untracked: false }]);
    expect(st.unstaged).toContainEqual({ path: 'README.md', origPath: null, status: 'M', untracked: false });
    expect(st.unstaged).toContainEqual({ path: 'untracked/dir/file.txt', origPath: null, status: 'A', untracked: true });

    expect(await ra.stashes()).toEqual([]);
  });

  it('merge commit has no files; detached HEAD; show()', async () => {
    const { a, ra } = scenario();
    g(a, 'switch', '-q', '-c', 'side');
    commit(a, 'side.txt', 's', 'Side');
    g(a, 'switch', '-q', 'main');
    commit(a, 'main.txt', 'm', 'Main');
    g(a, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const head = g(a, 'rev-parse', 'HEAD').trim();
    expect(await ra.commitFiles(head)).toEqual([]);
    const log = await ra.log(100);
    expect(log[0].parents.length).toBe(2);

    expect(await ra.show('HEAD', 'main.txt')).toBe('m');
    expect(await ra.show(`${head}^`, 'side.txt')).toBe(''); // not in first parent
    expect(await ra.show('HEAD', 'nope.txt')).toBe('');
    expect(await ra.show('', 'main.txt')).toBe('');
    put(a, 'idx.txt', 'indexed');
    g(a, 'add', 'idx.txt');
    put(a, 'idx.txt', 'worktree');
    expect(await ra.show(':', 'idx.txt')).toBe('indexed');
    expect(await ra.show(':', 'zzz.txt')).toBe('');

    g(a, 'checkout', '-q', '--detach', 'HEAD^');
    expect(await ra.summary()).toMatchObject({ branch: null, upstream: null });
    expect((await ra.refs()).head.branch).toBeNull();
  });

  it('errors: NotARepo, GitMissing', async () => {
    const plain = fresh('plain');
    expect(await kind(new Repo(plain).summary())).toBe('NotARepo');
    expect(await kind(new Repo(plain, join(tmp, 'no-such-git')).summary())).toBe('GitMissing');
  });
});

describe('network', () => {
  it('push without upstream sets -u; fetch sees it; upstreamGone after remote delete', async () => {
    const { a, ra, rb, origin } = scenario();
    await ra.createBranch('feature', 'main', true);
    commit(a, 'f.txt', 'f', 'Feature work');
    expect((await ra.summary()).upstream).toBeNull();
    expect(await kind(ra.pull())).toBe('NoUpstream');
    await ra.push();
    expect(await ra.summary()).toMatchObject({ branch: 'feature', upstream: 'origin/feature', ahead: 0, behind: 0 });
    expect(g(origin, 'branch', '--list', 'feature').trim()).toBe('feature');

    await rb.fetch();
    expect((await rb.refs()).remotes.map((r) => r.name)).toContain('origin/feature');

    g(origin, 'branch', '-D', 'feature');
    await ra.fetch(); // --prune
    const feature = (await ra.refs()).locals.find((l) => l.name === 'feature');
    expect(feature).toMatchObject({ upstream: 'origin/feature', upstreamGone: true });
  });

  it('push rejected', async () => {
    const { a, b, ra, rb } = scenario();
    commit(a, 'a.txt', 'a', 'A change');
    await ra.push();
    commit(b, 'b.txt', 'b', 'B change');
    expect(await kind(rb.push())).toBe('PushRejected');
  });

  it('pull: fast-forward', async () => {
    const { a, b, ra, rb } = scenario();
    const sha = commit(a, 'a.txt', 'a', 'A change');
    await ra.push();
    await rb.pull();
    expect(g(b, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(await rb.summary()).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('pull: diverged makes a merge commit', async () => {
    const { a, b, ra, rb } = scenario();
    commit(a, 'a.txt', 'a', 'A change');
    await ra.push();
    commit(b, 'b.txt', 'b', 'B change');
    await rb.pull();
    const log = await rb.log(10);
    expect(log[0].parents.length).toBe(2);
    expect(log[0].subject).toMatch(/^Merge/);
    expect((await rb.summary()).ahead).toBe(2); // B change + merge
  });

  it('pull: conflict', async () => {
    const { a, b, ra, rb } = scenario();
    commit(a, 'README.md', 'from a\n', 'A edits README');
    await ra.push();
    commit(b, 'README.md', 'from b\n', 'B edits README');
    expect(await kind(rb.pull())).toBe('Conflict');
    expect((await rb.status()).unstaged).toContainEqual({ path: 'README.md', origPath: null, status: 'U', untracked: false });
  });

  it('pull: local changes in the way', async () => {
    const { a, b, ra, rb } = scenario();
    commit(a, 'README.md', 'from a\n', 'A edits README');
    await ra.push();
    put(b, 'README.md', 'dirty\n');
    expect(await kind(rb.pull())).toBe('LocalChanges');
  });

  it('pull: a branch named like an error keyword is not misclassified', async () => {
    const { a, ra, origin } = scenario();
    await ra.createBranch('conflict-unmerged-fix', 'main', true);
    commit(a, 'c.txt', 'c', 'C');
    await ra.push();
    g(origin, 'branch', '-D', 'conflict-unmerged-fix'); // no prune: upstream still resolves locally
    expect(await kind(ra.pull())).toBe('Other');
  });

  it('pull outside a repo is NotARepo, not NoUpstream', async () => {
    expect(await kind(new Repo(fresh('plain')).pull())).toBe('NotARepo');
  });

  it('push without upstream: remote choice and detached HEAD', async () => {
    const { a, ra, origin } = scenario();
    const other = fresh('aaa');
    g(other, 'init', '-q', '--bare', '-b', 'main');
    g(a, 'remote', 'add', 'aaa', other); // alphabetically before origin
    await ra.createBranch('f1', 'main', true);
    await ra.push();
    expect((await ra.summary()).upstream).toBe('origin/f1');
    g(a, 'config', 'remote.pushDefault', 'aaa');
    await ra.createBranch('f2', 'main', true);
    await ra.push();
    expect((await ra.summary()).upstream).toBe('aaa/f2');
    expect(g(origin, 'branch', '--list', 'f2').trim()).toBe('');
    g(a, 'checkout', '-q', '--detach', 'HEAD');
    expect(await kind(ra.push())).toBe('Other');
  });

  it('createBranch from a remote branch does not track it; push publishes under its own name', async () => {
    const { b, rb, origin } = scenario();
    await rb.createBranch('feat', 'origin/main', true);
    expect((await rb.summary()).upstream).toBeNull();
    commit(b, 'feat.txt', 'f', 'Feat');
    await rb.push();
    expect((await rb.summary()).upstream).toBe('origin/feat');
    expect(g(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('Initial commit');
  });
});

describe('branches', () => {
  it('checkoutRemote creates a tracking branch, then switches to the existing one', async () => {
    const { a, ra, rb } = scenario();
    await ra.createBranch('develop', 'main', true);
    commit(a, 'd.txt', 'd', 'Develop');
    await ra.push();
    await rb.fetch();
    await rb.checkoutRemote('origin/develop');
    expect(await rb.summary()).toMatchObject({ branch: 'develop', upstream: 'origin/develop' });
    await rb.checkout('main');
    await rb.checkoutRemote('origin/develop');
    expect((await rb.summary()).branch).toBe('develop');
  });

  it('createBranch (with/without checkout), rename, invalid name', async () => {
    const { ra } = scenario();
    await ra.createBranch('one', 'main', false);
    expect((await ra.refs()).head.branch).toBe('main');
    await ra.createBranch('two', 'main', true);
    expect((await ra.refs()).head.branch).toBe('two');
    await ra.renameBranch('one', 'uno');
    expect((await ra.refs()).locals.map((l) => l.name).sort()).toEqual(['main', 'two', 'uno']);
    expect(await kind(ra.createBranch('bad name', 'main', false))).toBe('Other');
    expect(await kind(ra.createBranch('x..y', 'main', true))).toBe('Other');
  });

  it('deleteBranch: unmerged -> NotFullyMerged, then force', async () => {
    const { a, ra } = scenario();
    await ra.createBranch('wip', 'main', true);
    commit(a, 'w.txt', 'w', 'WIP commit');
    await ra.checkout('main');
    expect(await kind(ra.deleteBranch('wip', false))).toBe('NotFullyMerged');
    await ra.deleteBranch('wip', true);
    expect((await ra.refs()).locals.map((l) => l.name)).toEqual(['main']);
    await ra.createBranch('merged', 'main', false);
    await ra.deleteBranch('merged', false);
  });

  it('checkout with conflicting local changes -> LocalChanges', async () => {
    const { a, ra } = scenario();
    await ra.createBranch('other', 'main', true);
    commit(a, 'README.md', 'other\n', 'Other edits README');
    await ra.checkout('main');
    put(a, 'README.md', 'dirty\n');
    expect(await kind(ra.checkout('other'))).toBe('LocalChanges');
  });
});

describe('stash', () => {
  it('push/apply/pop/drop with an untracked file', async () => {
    const { a, ra } = scenario();
    put(a, 'README.md', 'tracked change\n');
    put(a, 'new/untracked.txt', 'u');
    await ra.stashPush('my message');
    expect((await ra.status())).toEqual({ staged: [], unstaged: [] });

    const list = await ra.stashes();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ index: 0 });
    expect(list[0].message).toContain('my message');

    const files = await ra.stashFiles(0);
    expect(files).toContainEqual({ path: 'README.md', origPath: null, status: 'M', add: null, del: null, untracked: false });
    expect(files).toContainEqual({ path: 'new/untracked.txt', origPath: null, status: 'A', add: null, del: null, untracked: true });

    await ra.stashApply(0);
    expect((await ra.status()).unstaged.length).toBe(2);
    expect((await ra.stashes()).length).toBe(1); // apply keeps it
    g(a, 'stash', 'push', '-u', '-q'); // clean again, now two stashes
    await ra.stashDrop(0);
    expect((await ra.stashes()).length).toBe(1);
    await ra.stashPop(0);
    expect((await ra.status()).unstaged.map((f) => f.path).sort()).toEqual(['README.md', 'new/untracked.txt']);
    expect(await ra.stashes()).toEqual([]);
  });

  it('clean tree -> NothingToStash', async () => {
    const { ra } = scenario();
    expect(await kind(ra.stashPush())).toBe('NothingToStash');
  });

  it('pop onto conflicting changes -> Conflict', async () => {
    const { a, ra } = scenario();
    put(a, 'README.md', 'stashed\n');
    await ra.stashPush();
    commit(a, 'README.md', 'committed\n', 'Edit README');
    const k = await kind(ra.stashPop(0));
    expect(k).toBe('Conflict');
    expect((await ra.stashes()).length).toBe(1); // kept after a failed pop
    // the index of a conflicted file has no stage 0: show(':') falls back to "ours"
    expect((await ra.status()).unstaged).toContainEqual({ path: 'README.md', origPath: null, status: 'U', untracked: false });
    expect(await ra.show(':', 'README.md')).toBe('committed\n');
  });
});

// The command layer (src/commands/mutations.ts) glues Repo to VS Code; these run its flows without the UI:
// the same Repo calls in the same order, with the pure message helpers the notifications are built from.
describe('command flows', () => {
  it('commit on a behind branch -> push rejected -> pull merges -> push passes', async () => {
    const { a, b, ra, rb } = scenario();
    commit(a, 'a.txt', 'a', 'A change');
    await ra.push();
    commit(b, 'b.txt', 'b', 'B change');
    const before = await rb.summary();
    const err = await rb.push().catch((e: unknown) => e as GitError);
    expect(err).toBeInstanceOf(GitError);
    expect(errorPlan(err as GitError, 'push', before.branch)).toMatchObject({ level: 'error', actions: ['pull', 'output'], text: expect.stringContaining("Try running 'Pull' first") });

    const beforePull = await rb.summary();
    await rb.pull();
    expect(pullMessage(beforePull, await rb.summary())).toMatch(/^Branches had diverged\. Merged origin\/main into 'main'\.$/);
    const beforePush = await rb.summary();
    await rb.push();
    expect(pushMessage(beforePush, await rb.summary())).toBe('Pushed 2 commits to origin/main.');
    expect(pushMessage(await rb.summary(), await rb.summary())).toBe('Everything up-to-date.');
  });

  it('pull messages: up to date, fast-forward; first push publishes', async () => {
    const { a, ra, rb } = scenario();
    let before = await rb.summary();
    await rb.pull();
    expect(pullMessage(before, await rb.summary())).toBe('Already up to date.');
    const sha = commit(a, 'a.txt', 'a', 'A change');
    await ra.push();
    before = await rb.summary();
    await rb.pull();
    expect(pullMessage(before, await rb.summary())).toBe(`Fast-forwarded 'main' to ${sha.slice(0, 7)}.`);

    await rb.createBranch('feat', 'main', true);
    const beforeFirst = await rb.summary();
    await rb.push();
    expect(pushMessage(beforeFirst, await rb.summary())).toBe("Published 'feat' to origin/feat.");
  });

  it('pull without upstream -> publish plan; conflict -> Open Source Control; Auth -> terminal line from the real args', async () => {
    const { a, b, ra, rb } = scenario();
    await ra.createBranch('solo', 'main', true);
    const noUp = await ra.pull().catch((e: unknown) => e as GitError);
    expect(errorPlan(noUp as GitError, 'pull', 'solo')).toMatchObject({ level: 'warn', actions: ['publish'], text: "The branch 'solo' has no remote branch. Would you like to publish it?" });

    g(a, 'switch', '-q', 'main');
    commit(a, 'README.md', 'from a\n', 'A edits README');
    await ra.push();
    commit(b, 'README.md', 'from b\n', 'B edits README');
    const conflict = await rb.pull().catch((e: unknown) => e as GitError);
    expect(errorPlan(conflict as GitError, 'pull')).toMatchObject({ actions: ['scm', 'output'] });
    // the line for the terminal replays the failing call without the -C/-c prefix
    expect(terminalCommand('git', (conflict as GitError).args)).toBe('git pull --no-rebase --no-edit');
    expect(terminalCommand('/opt/my git/git', ['-C', '/r', '-c', 'core.quotePath=false', 'push', '-u', 'origin', 'it\'s'])).toBe("'/opt/my git/git' push -u origin 'it'\\''s'");
  });

  it('branches: create from a sha, rename, delete with the unpushed note, force delete', async () => {
    const { a, ra } = scenario();
    const first = g(a, 'rev-parse', 'HEAD').trim();
    commit(a, 'x.txt', 'x', 'Second');
    await ra.createBranch('from-sha', first, true);
    expect((await ra.refs()).head.branch).toBe('from-sha');
    await ra.renameBranch('from-sha', 'renamed');
    await ra.checkout('main');
    commit(a, 'y.txt', 'y', 'Only on renamed');
    g(a, 'switch', '-q', 'renamed');
    commit(a, 'z.txt', 'z', 'Unmerged work');
    await ra.checkout('main');
    const b = (await ra.refs()).locals.find((l) => l.name === 'renamed')!;
    expect(deleteDetail(b)).toMatch(/never pushed/);
    expect(await kind(ra.deleteBranch('renamed', false))).toBe('NotFullyMerged');
    await ra.deleteBranch('renamed', true);
    expect((await ra.refs()).locals.map((l) => l.name)).toEqual(['main']);
    const main = (await ra.refs()).locals[0];
    expect(deleteDetail({ ...main, ahead: 2 })).toBe('2 commits are not pushed to origin/main. They will only be reachable through the reflog.');
    expect(deleteDetail({ ...main, ahead: 0 })).toBe('origin/main stays on the server.');
  });

  it('stash with an untracked file, found by sha after the list shifted, then pop', async () => {
    const { a, ra } = scenario();
    put(a, 'new.txt', 'untracked');
    put(a, 'README.md', 'changed\n');
    await ra.stashPush('first');
    const [first] = await ra.stashes();
    put(a, 'other.txt', 'o');
    await ra.stashPush();
    const list = await ra.stashes();
    expect(list).toHaveLength(2);
    expect(first.index).toBe(0);                       // stale index in an old tree node...
    const idx = resolveStashIndex(list, first.sha);    // ...re-resolved from the sha
    expect(idx).toBe(1);
    await ra.stashPop(idx!);
    expect(g(a, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([' M README.md', '?? new.txt']);
    expect(resolveStashIndex(await ra.stashes(), first.sha)).toBeUndefined();
  });

  it('refs that start with "-" (legal in a clone) never turn into git options', async () => {
    const { a, ra } = scenario();
    const base = g(a, 'rev-parse', 'HEAD').trim();
    g(a, 'update-ref', 'refs/tags/--discard-changes', base);
    g(a, 'update-ref', 'refs/heads/-d', base);
    commit(a, 'next.txt', 'n', 'Next');
    await ra.createBranch('from-tag', '--discard-changes', true);
    expect(await ra.summary()).toMatchObject({ branch: 'from-tag', sha: base });
    await ra.checkout('-d');
    expect((await ra.refs()).head.branch).toBe('-d'); // `switch -d` would have detached HEAD
    await ra.checkout('main');
    await ra.renameBranch('-d', 'dash');
    await ra.deleteBranch('dash', true);
    expect((await ra.refs()).locals.map((l) => l.name).sort()).toEqual(['from-tag', 'main']);
  });

  it('checkout over local changes -> LocalChanges plan offers Stash Changes', async () => {
    const { a, ra } = scenario();
    await ra.createBranch('other', 'main', false);
    g(a, 'switch', '-q', 'other');
    commit(a, 'README.md', 'other\n', 'Other edits README');
    g(a, 'switch', '-q', 'main');
    put(a, 'README.md', 'dirty\n');
    const e = await ra.checkout('other').catch((x: unknown) => x as GitError);
    expect(errorPlan(e as GitError, 'checkout')).toMatchObject({ actions: ['stash', 'scm'] });
  });
});

describe('tags', () => {
  it('lightweight and annotated tag on a sha, invalid name rejected, delete', async () => {
    const { a, ra } = scenario();
    const c1 = g(a, 'rev-parse', 'HEAD').trim();
    const c2 = commit(a, 'f.txt', 'x', 'Second');
    await ra.createTag('light', c1);
    await ra.createTag('ann', c2, 'release notes');
    expect(g(a, 'cat-file', '-t', 'light').trim()).toBe('commit');
    expect(g(a, 'cat-file', '-t', 'ann').trim()).toBe('tag');
    expect(g(a, 'tag', '-l', '--format=%(contents:subject)', 'ann').trim()).toBe('release notes');
    expect((await ra.refs()).tags).toEqual(expect.arrayContaining([{ name: 'light', sha: c1 }, { name: 'ann', sha: c2 }]));
    expect(await kind(ra.createTag('bad name', c1))).toBe('Other');
    expect(await kind(ra.createTag('a..b', c1))).toBe('Other');
    expect(await kind(ra.createTag('light', c2))).toBe('Other'); // exists
    await ra.deleteTag('light');
    expect((await ra.refs()).tags.map((t) => t.name)).toEqual(['ann']);
    expect(await kind(ra.deleteTag('light'))).toBe('Other');
  });

  it('pushTag goes to origin (pushDefault wins when set); no remote -> error', async () => {
    const { origin, a, ra } = scenario();
    await ra.createTag('v1', g(a, 'rev-parse', 'HEAD').trim());
    expect(await ra.pushTag('v1')).toBe('origin');
    expect(g(origin, 'tag', '-l').trim()).toBe('v1');

    const other = fresh('other');
    g(other, 'init', '-q', '--bare', '-b', 'main');
    g(a, 'remote', 'add', 'second', other);
    g(a, 'config', 'remote.pushDefault', 'second');
    await ra.createTag('v2', g(a, 'rev-parse', 'HEAD').trim());
    expect(await ra.pushTag('v2')).toBe('second');
    expect(g(other, 'tag', '-l').trim()).toBe('v2');

    const lone = init('lone');
    commit(lone, 'a.txt', 'a', 'c');
    const rl = new Repo(lone);
    await rl.createTag('t', g(lone, 'rev-parse', 'HEAD').trim());
    expect(errorPlan(await rl.pushTag('t').catch((x: unknown) => x as GitError) as GitError, 'push')).toMatchObject({ text: expect.stringContaining('No remote') });
  });

  it('upstream: set/unset, remoteUrl, linkRemote, isOnRemote before/after push', async () => {
    const { origin, a, ra } = scenario();
    expect(await ra.remotes()).toEqual(['origin']);
    expect(await ra.remoteUrl('origin')).toBe(origin);
    expect(await ra.remoteUrl('nope')).toBeNull();
    expect(await ra.linkRemote()).toBe('origin');

    g(a, 'switch', '-q', '-c', 'feat');
    const c = commit(a, 'f.txt', 'x', 'On feat');
    expect(await ra.isOnRemote(c)).toBe(false);
    expect(await ra.isOnRemote(g(a, 'rev-parse', 'main').trim())).toBe(true);
    expect((await ra.refs()).locals.find((b) => b.name === 'feat')?.upstream).toBeNull();

    g(a, 'push', '-q', 'origin', 'feat');
    g(a, 'fetch', '-q', 'origin');
    expect(await ra.isOnRemote(c)).toBe(true);

    await ra.setUpstream('feat', 'origin/feat');
    expect((await ra.refs()).locals.find((b) => b.name === 'feat')?.upstream).toBe('origin/feat');
    await ra.setUpstream('feat', null);
    expect((await ra.refs()).locals.find((b) => b.name === 'feat')?.upstream).toBeNull();
    expect(await kind(ra.setUpstream('feat', 'origin/missing'))).toBe('Other');

    const other = fresh('other');
    g(other, 'init', '-q', '--bare', '-b', 'main');
    g(a, 'remote', 'add', 'aaa', other);
    g(a, 'config', 'branch.feat.remote', 'aaa');
    expect(await ra.linkRemote()).toBe('aaa'); // the branch's own remote wins over origin
  });
});

describe('reset, cherry-pick, revert', () => {
  const head = (d: string) => g(d, 'rev-parse', 'HEAD').trim();
  const status = (d: string) => g(d, 'status', '--porcelain').split('\n').filter(Boolean);

  it('reset soft / mixed / hard: HEAD moves, index and worktree follow the mode', async () => {
    const { a, ra } = scenario();
    const c1 = head(a);
    const c2 = commit(a, 'f.txt', 'two\n', 'Second');

    await ra.reset('soft', c1);
    expect(head(a)).toBe(c1);
    expect(status(a)).toEqual(['A  f.txt']); // staged
    g(a, 'commit', '-q', '-m', 'Second again');

    await ra.reset('mixed', c1);
    expect(head(a)).toBe(c1);
    expect(status(a)).toEqual(['?? f.txt']); // kept, unstaged

    g(a, 'add', '-A'); g(a, 'commit', '-q', '-m', 'Third');
    await ra.reset('hard', c1);
    expect(head(a)).toBe(c1);
    expect(status(a)).toEqual([]);
    expect(g(a, 'ls-files').trim()).toBe('README.md');
    expect(c2).not.toBe(c1);
  });

  it('currentBranch: name, null when detached', async () => {
    const { a, ra } = scenario();
    expect(await ra.currentBranch()).toBe('main');
    g(a, 'checkout', '-q', '--detach');
    expect(await ra.currentBranch()).toBeNull();
  });

  it('parentCount and isInHead', async () => {
    const { a, ra } = scenario();
    const base = head(a);
    g(a, 'switch', '-q', '-c', 'side');
    const s1 = commit(a, 's.txt', 's\n', 'Side');
    g(a, 'switch', '-q', 'main');
    commit(a, 'm.txt', 'm\n', 'Main');
    expect(await ra.isInHead(s1)).toBe(false);
    g(a, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    expect(await ra.isInHead(s1)).toBe(true);
    expect(await ra.parentCount(base)).toBe(0);
    expect(await ra.parentCount(s1)).toBe(1);
    expect(await ra.parentCount(head(a))).toBe(2);
  });

  it('cherry-pick: clean; the commit is new on top of HEAD', async () => {
    const { a, ra } = scenario();
    g(a, 'switch', '-q', '-c', 'side');
    const s1 = commit(a, 's.txt', 's\n', 'Side change');
    g(a, 'switch', '-q', 'main');
    commit(a, 'm.txt', 'm\n', 'Main'); // HEAD differs from the pick's parent, so the pick makes a new commit
    expect(await ra.isInHead(s1)).toBe(false);
    expect(await ra.cherryPick(s1)).toBe(true);
    expect(g(a, 'log', '-1', '--format=%s').trim()).toBe('Side change');
    expect(head(a)).not.toBe(s1);
    expect(status(a)).toEqual([]);
  });

  it('cherry-pick: conflict leaves the operation in progress, kind Conflict, plan opens Source Control', async () => {
    const { a, ra } = scenario();
    g(a, 'switch', '-q', '-c', 'side');
    const s1 = commit(a, 'README.md', 'side\n', 'Side readme');
    g(a, 'switch', '-q', 'main');
    commit(a, 'README.md', 'main\n', 'Main readme');
    let err: unknown;
    try { await ra.cherryPick(s1); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('Conflict');
    expect(g(a, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD').trim()).toBe(s1);
    const plan = errorPlan(err as GitError, 'cherryPick', 'main');
    expect(plan?.actions).toEqual(['scm']);
    expect(plan?.text).toContain('git cherry-pick --abort');
  });

  it('cherry-pick: already in HEAD is detectable; an empty pick is aborted and reported as false', async () => {
    const { a, ra } = scenario();
    const base = head(a);
    expect(await ra.isInHead(base)).toBe(true);

    // The same change made independently on both branches: the pick is empty.
    g(a, 'switch', '-q', '-c', 'side');
    const s1 = commit(a, 'same.txt', 'same\n', 'Side same');
    g(a, 'switch', '-q', 'main');
    commit(a, 'same.txt', 'same\n', 'Main same');
    const before = head(a);
    expect(await ra.isInHead(s1)).toBe(false);
    expect(await ra.cherryPick(s1)).toBe(false);
    expect(head(a)).toBe(before);
    expect(() => g(a, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow(); // aborted, not left in progress
    expect(status(a)).toEqual([]);
  });

  it('cherry-pick over conflicting local changes -> LocalChanges', async () => {
    const { a, ra } = scenario();
    g(a, 'switch', '-q', '-c', 'side');
    const s1 = commit(a, 'README.md', 'side\n', 'Side readme');
    g(a, 'switch', '-q', 'main');
    put(a, 'README.md', 'dirty\n');
    expect(await kind(ra.cherryPick(s1))).toBe('LocalChanges');
  });

  it('cherry-pick of a merge commit uses -m 1', async () => {
    const { a, ra } = scenario();
    g(a, 'switch', '-q', '-c', 'feat');
    commit(a, 'feat.txt', 'f\n', 'Feat');
    g(a, 'switch', '-q', 'main');
    commit(a, 'm.txt', 'm\n', 'Main');
    g(a, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
    const merge = head(a);
    g(a, 'switch', '-q', '-c', 'target', 'HEAD~1'); // main before the merge
    expect(await ra.cherryPick(merge)).toBe(true);
    expect(g(a, 'ls-files').split('\n')).toContain('feat.txt');
  });

  it('revert: a normal commit and a merge commit', async () => {
    const { a, ra } = scenario();
    const c = commit(a, 'x.txt', 'x\n', 'Add x');
    await ra.revert(c);
    expect(g(a, 'log', '-1', '--format=%s').trim()).toBe('Revert "Add x"');
    expect(g(a, 'ls-files').split('\n')).not.toContain('x.txt');
    // Reverting it again changes nothing: false, no revert left in progress.
    const before = head(a);
    expect(await ra.revert(c)).toBe(false);
    expect(head(a)).toBe(before);
    expect(g(a, 'status', '--porcelain').trim()).toBe('');

    g(a, 'switch', '-q', '-c', 'feat');
    commit(a, 'feat.txt', 'f\n', 'Feat');
    g(a, 'switch', '-q', 'main');
    commit(a, 'm.txt', 'm\n', 'Main');
    g(a, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
    await ra.revert(head(a));
    expect(g(a, 'ls-files').split('\n')).not.toContain('feat.txt');
    expect(g(a, 'ls-files').split('\n')).toContain('m.txt'); // the mainline side stays
  });

  it('revert conflict -> Conflict, revert in progress', async () => {
    const { a, ra } = scenario();
    const c = commit(a, 'README.md', 'one\n', 'One');
    commit(a, 'README.md', 'two\n', 'Two');
    expect(await kind(ra.revert(c))).toBe('Conflict');
    expect(g(a, 'rev-parse', '-q', '--verify', 'REVERT_HEAD').trim()).toBe(c);
  });
});

describe('compare with working tree and patch', () => {
  it('diffWithWorktree: modified, added, deleted, renamed; untracked ignored', async () => {
    const dir = init('wt');
    commit(dir, 'mod.txt', 'one\n', 'init');
    commit(dir, 'del.txt', 'gone\n', 'del');
    const base = commit(dir, 'ren.txt', 'rename me please\nsome more lines\nand more\n', 'ren');
    put(dir, 'mod.txt', 'two\n');
    g(dir, 'rm', '-q', 'del.txt');
    g(dir, 'mv', 'ren.txt', 'renamed.txt');
    put(dir, 'added.txt', 'new\n');
    g(dir, 'add', 'added.txt');
    put(dir, 'untracked.txt', 'u\n');
    const r = await new Repo(dir).diffWithWorktree(base);
    const by = Object.fromEntries(r.map((x) => [x.path, x]));
    expect(by['mod.txt'].status).toBe('M');
    expect(by['del.txt'].status).toBe('D');
    expect(by['added.txt'].status).toBe('A');
    expect(by['renamed.txt']).toMatchObject({ status: 'R', origPath: 'ren.txt' });
    expect(by['untracked.txt']).toBeUndefined();
    expect(await new Repo(dir).diffWithWorktree('HEAD')).not.toHaveLength(0);
  });

  it('formatPatch: normal commit gives a patch, merge commit gives nothing', async () => {
    const dir = init('patch');
    commit(dir, 'a.txt', 'a\n', 'init');
    g(dir, 'checkout', '-q', '-b', 'side');
    const side = commit(dir, 'b.txt', 'b\n', 'Side: work');
    g(dir, 'checkout', '-q', 'main');
    commit(dir, 'c.txt', 'c\n', 'main work');
    g(dir, 'merge', '--no-ff', '-q', '-m', 'merge side', 'side');
    const repo = new Repo(dir);
    const patch = await repo.formatPatch(side);
    expect(patch).toContain('Subject: [PATCH] Side: work');
    expect(patch).toContain('+++ b/b.txt');
    expect(await repo.commitSubject(side)).toBe('Side: work');
    expect(await repo.formatPatch('HEAD')).toBe('');
  });
});

describe('WIP: stage, unstage, discard, commit', () => {
  const porcelain = (dir: string) => g(dir, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean);
  const fc = (path: string, status: FileChange['status'] = 'M', extra: Partial<FileChange> = {}): FileChange =>
    ({ path, origPath: null, status, untracked: false, ...extra });

  it('stage: modified, untracked and deleted files; stageAll', async () => {
    const dir = init('stage');
    commit(dir, 'mod.txt', 'one\n', 'init');
    commit(dir, 'del.txt', 'gone\n', 'del');
    put(dir, 'mod.txt', 'two\n');
    put(dir, 'new.txt', 'n\n');
    put(dir, 'other.txt', 'o\n');
    rmSync(join(dir, 'del.txt'));
    const repo = new Repo(dir);
    await repo.stage([fc('mod.txt'), fc('new.txt', 'A', { untracked: true }), fc('del.txt', 'D')]);
    expect(porcelain(dir)).toEqual(['D  del.txt', 'M  mod.txt', 'A  new.txt', '?? other.txt']);
    await repo.stage([]); // no-op
    await repo.stageAll();
    expect(porcelain(dir)).toContain('A  other.txt');
    const st = await repo.status();
    expect(st.unstaged).toEqual([]);
    expect(st.staged.map((f) => f.path).sort()).toEqual(['del.txt', 'mod.txt', 'new.txt', 'other.txt']);
  });

  it('stage and unstage treat paths literally (-x, a*b.txt)', async () => {
    const dir = init('literal');
    commit(dir, 'seed.txt', 's\n', 'init');
    put(dir, '-x', 'dash\n');
    put(dir, 'a*b.txt', 'star\n');
    put(dir, 'aXb.txt', 'x\n');
    const repo = new Repo(dir);
    await repo.stage([fc('-x', 'A', { untracked: true }), fc('a*b.txt', 'A', { untracked: true })]);
    expect(porcelain(dir)).toEqual(['A  -x', 'A  a*b.txt', '?? aXb.txt']); // the glob did not catch aXb.txt
    await repo.unstage([fc('a*b.txt', 'A')]);
    expect(porcelain(dir)).toEqual(['A  -x', '?? a*b.txt', '?? aXb.txt']);
    await repo.unstage([fc('-x', 'A')]);
    expect(porcelain(dir)).toEqual(['?? -x', '?? a*b.txt', '?? aXb.txt']);
  });

  it('unstage: normal branch, unstageAll, a staged rename (both sides), and an unborn branch', async () => {
    const dir = init('unstage');
    commit(dir, 'mod.txt', 'one\n', 'init');
    commit(dir, 'ren.txt', 'rename me please\nsome more lines\nand more\n', 'ren');
    put(dir, 'mod.txt', 'two\n');
    g(dir, 'mv', 'ren.txt', 'renamed.txt');
    g(dir, 'add', '-A');
    const repo = new Repo(dir);
    const staged = (await repo.status()).staged;
    const rename = staged.find((f) => f.status === 'R')!;
    expect(rename).toMatchObject({ path: 'renamed.txt', origPath: 'ren.txt' });
    await repo.unstage([rename]);
    expect(porcelain(dir).sort()).toEqual(['?? renamed.txt', 'M  mod.txt', ' D ren.txt'].sort());
    await repo.unstage([fc('mod.txt')]);
    expect(porcelain(dir)).toContain(' M mod.txt');
    g(dir, 'add', '-A');
    await repo.unstageAll();
    expect((await repo.status()).staged).toEqual([]);

    const unborn = init('unborn');
    put(unborn, 'a.txt', 'a\n');
    put(unborn, 'b.txt', 'b\n');
    g(unborn, 'add', '-A');
    const ur = new Repo(unborn);
    await ur.unstage([fc('a.txt', 'A')]);
    expect(porcelain(unborn)).toEqual(['A  b.txt', '?? a.txt']);
    await ur.unstageAll();
    expect(porcelain(unborn)).toEqual(['?? a.txt', '?? b.txt']);
  });

  it('discard: tracked (a staged part survives) and untracked; refuses a conflicted file', async () => {
    const dir = init('discard');
    commit(dir, 'a.txt', 'v1\n', 'init');
    commit(dir, 'b.txt', 'b1\n', 'b');
    put(dir, 'a.txt', 'v2\n');
    g(dir, 'add', 'a.txt');
    put(dir, 'a.txt', 'v3\n'); // partially staged
    put(dir, 'b.txt', 'b2\n');
    put(dir, 'u/new.txt', 'untracked\n');
    put(dir, 'keep.txt', 'k\n');
    const repo = new Repo(dir);
    await repo.discard(fc('a.txt'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('v2\n');
    expect(g(dir, 'show', ':a.txt')).toBe('v2\n');
    await repo.discard(fc('b.txt'));
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b1\n');
    await repo.discard(fc('u/new.txt', 'A', { untracked: true }));
    expect(existsSync(join(dir, 'u/new.txt'))).toBe(false);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(await kind(repo.discard(fc('a.txt', 'U')))).toBe('Other');
  });

  it('discardAll: resets staged and unstaged, deletes untracked, keeps ignored; refuses an unborn branch', async () => {
    const dir = init('discardall');
    commit(dir, '.gitignore', 'ignored.log\n', 'init');
    commit(dir, 'a.txt', 'v1\n', 'a');
    put(dir, 'a.txt', 'v2\n');
    g(dir, 'add', 'a.txt');
    put(dir, 'a.txt', 'v3\n');
    put(dir, 'staged-new.txt', 's\n');
    g(dir, 'add', 'staged-new.txt');
    put(dir, 'dir/untracked.txt', 'u\n');
    put(dir, 'ignored.log', 'i\n');
    const repo = new Repo(dir);
    await repo.discardAll();
    expect(porcelain(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(dir, 'dir'))).toBe(false);
    expect(existsSync(join(dir, 'ignored.log'))).toBe(true);

    const unborn = init('discardall-unborn');
    put(unborn, 'x.txt', 'x\n');
    expect(await kind(new Repo(unborn).discardAll())).toBe('Other');
    expect(existsSync(join(unborn, 'x.txt'))).toBe(true);
  });

  it('commit: two-paragraph message, first commit on an unborn branch; headMessage', async () => {
    const dir = init('commit');
    const repo = new Repo(dir);
    expect(await repo.headMessage()).toBeNull();
    put(dir, 'a.txt', 'a\n');
    g(dir, 'add', 'a.txt');
    await repo.commit('First commit\n\nSecond paragraph\nstill second', { amend: false });
    expect(g(dir, 'log', '-1', '--format=%B').trimEnd()).toBe('First commit\n\nSecond paragraph\nstill second');
    expect(await repo.headMessage()).toEqual({ summary: 'First commit', description: 'Second paragraph\nstill second' });
    put(dir, 'b.txt', 'b\n');
    g(dir, 'add', 'b.txt');
    await repo.commit('Only summary', { amend: false });
    expect(await repo.headMessage()).toEqual({ summary: 'Only summary', description: '' });
    expect(g(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('amend: message replaced, parent unchanged, staged changes folded in', async () => {
    const dir = init('amend');
    const first = commit(dir, 'a.txt', 'a\n', 'Base');
    commit(dir, 'b.txt', 'b\n', 'Old message');
    put(dir, 'c.txt', 'c\n');
    g(dir, 'add', 'c.txt');
    await new Repo(dir).commit('New message\n\nWith body', { amend: true });
    expect(g(dir, 'log', '-1', '--format=%B').trimEnd()).toBe('New message\n\nWith body');
    expect(g(dir, 'rev-parse', 'HEAD~1').trim()).toBe(first);
    expect(g(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['b.txt', 'c.txt']);
  });

  it('commit: a failing pre-commit hook gives GitError(Other) with stderr, and no commit', async () => {
    const dir = init('hook');
    const base = commit(dir, 'a.txt', 'a\n', 'Base');
    const hooks = join(dir, 'myhooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed: no semicolons" >&2\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    g(dir, 'config', 'core.hooksPath', hooks);
    put(dir, 'b.txt', 'b\n');
    g(dir, 'add', 'b.txt');
    let err: unknown;
    try { await new Repo(dir).commit('Should not land', { amend: false }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('Other');
    expect((err as GitError).stderr).toContain('lint failed');
    expect((err as GitError).message).toContain('lint failed');
    expect(g(dir, 'rev-parse', 'HEAD').trim()).toBe(base);
  });

  it('commit: nothing staged is a GitError(Other)', async () => {
    const dir = init('empty-commit');
    commit(dir, 'a.txt', 'a\n', 'Base');
    expect(await kind(new Repo(dir).commit('Empty', { amend: false }))).toBe('Other');
  });

  it('stage, unstage and discard paths with spaces, a leading colon and non-ASCII', async () => {
    const dir = init('names');
    for (const f of ['my file.txt', ':colon.txt', 'тест ü.txt']) commit(dir, f, 'v1\n', `add ${f}`);
    for (const f of ['my file.txt', ':colon.txt', 'тест ü.txt']) put(dir, f, 'v2\n');
    const repo = new Repo(dir);
    const files = (await repo.status()).unstaged;
    expect(files.map((f) => f.path).sort()).toEqual([':colon.txt', 'my file.txt', 'тест ü.txt']);
    await repo.stage(files);
    expect((await repo.status()).staged.map((f) => f.path).sort()).toEqual([':colon.txt', 'my file.txt', 'тест ü.txt']);
    await repo.unstage(files);
    expect((await repo.status()).staged).toEqual([]);
    for (const f of files) await repo.discard(f);
    expect((await repo.status()).unstaged).toEqual([]);
    expect(readFileSync(join(dir, 'тест ü.txt'), 'utf8')).toBe('v1\n');
  });

  it('stage on a conflicted (U) file marks it resolved; the merge commit gets our message; headMessage reads it', async () => {
    const dir = init('conflict');
    commit(dir, 'c.txt', 'base\n', 'Base');
    g(dir, 'checkout', '-q', '-b', 'side');
    commit(dir, 'c.txt', 'side\n', 'Side');
    g(dir, 'checkout', '-q', 'main');
    commit(dir, 'c.txt', 'main\n', 'Main');
    expect(() => g(dir, 'merge', '-q', 'side')).toThrow();
    const repo = new Repo(dir);
    const u = (await repo.status()).unstaged.find((f) => f.path === 'c.txt')!;
    expect(u.status).toBe('U');
    expect(await kind(repo.discard(u))).toBe('Other');
    put(dir, 'c.txt', 'resolved\n');
    await repo.stage([u]);
    const st = await repo.status();
    expect(st.unstaged).toEqual([]);
    expect(st.staged.map((f) => [f.path, f.status])).toEqual([['c.txt', 'M']]);
    await repo.commit('Merge side\n\nResolved c.txt', { amend: false });
    expect(g(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    expect(await repo.headMessage()).toEqual({ summary: 'Merge side', description: 'Resolved c.txt' });
  });

  it('discard: intent-to-add file and an unstaged (intent-to-add) rename; a nested repository is refused', async () => {
    const dir = init('ita');
    commit(dir, 'old.txt', 'rename me please\nsome more lines\nand more\n', 'init');
    put(dir, 'ita.txt', 'hi\n');
    g(dir, 'add', '-N', 'ita.txt');
    g(dir, 'mv', 'old.txt', 'new.txt');
    g(dir, 'reset', '-q', '--', 'old.txt', 'new.txt');
    g(dir, 'add', '-N', 'new.txt');
    const repo = new Repo(dir);
    const un = (await repo.status()).unstaged;
    const ita = un.find((f) => f.path === 'ita.txt')!;
    const ren = un.find((f) => f.path === 'new.txt')!;
    expect(ita).toMatchObject({ status: 'A', untracked: false });
    expect(ren).toMatchObject({ status: 'R', origPath: 'old.txt' });
    await repo.discard(ita);
    await repo.discard(ren);
    expect(porcelain(dir)).toEqual([]);
    expect(existsSync(join(dir, 'ita.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'old.txt'), 'utf8')).toBe('rename me please\nsome more lines\nand more\n');

    const nested = join(dir, 'nested');
    mkdirSync(nested);
    g(nested, 'init', '-q');
    put(nested, 'x.txt', 'x\n');
    const n = (await repo.status()).unstaged.find((f) => f.path.startsWith('nested'))!;
    expect(n.path).toBe('nested/');
    expect(await kind(repo.discard(n))).toBe('Other');
    expect(existsSync(join(nested, 'x.txt'))).toBe(true);
  });

  it('commit returns the new HEAD; a cancel during a slow post-commit hook still counts as committed', async () => {
    const dir = init('post-commit');
    commit(dir, 'a.txt', 'a\n', 'Base');
    put(dir, 'b.txt', 'b\n');
    g(dir, 'add', 'b.txt');
    const repo = new Repo(dir);
    expect(await repo.commit('Plain', { amend: false })).toBe(g(dir, 'rev-parse', 'HEAD').trim());
    const hooks = join(dir, 'posthooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(hooks, 'post-commit'), 0o755);
    g(dir, 'config', 'core.hooksPath', hooks);
    put(dir, 'c.txt', 'c\n');
    g(dir, 'add', 'c.txt');
    const ac = new AbortController();
    const before = g(dir, 'rev-parse', 'HEAD').trim();
    const p = repo.commit('Landed', { amend: false, signal: ac.signal });
    // abort only once the commit exists (the hook is then sleeping)
    for (let i = 0; i < 100 && g(dir, 'rev-parse', 'HEAD').trim() === before; i++) await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const sha = await p;
    expect(sha).toBe(g(dir, 'rev-parse', 'HEAD').trim());
    expect(g(dir, 'log', '-1', '--format=%s').trim()).toBe('Landed');
  });

  it('amend with nothing staged only rewrites the message', async () => {
    const dir = init('amend-msg');
    const first = commit(dir, 'a.txt', 'a\n', 'Base');
    const old = commit(dir, 'b.txt', 'b\n', 'Old');
    await new Repo(dir).commit('Reworded', { amend: true });
    expect(g(dir, 'log', '-1', '--format=%s').trim()).toBe('Reworded');
    expect(g(dir, 'rev-parse', 'HEAD~1').trim()).toBe(first);
    expect(g(dir, 'rev-parse', 'HEAD^{tree}').trim()).toBe(g(dir, 'rev-parse', `${old}^{tree}`).trim());
  });

  it('commit cancelled during a slow pre-commit hook: Cancelled, no commit, no index.lock left', async () => {
    const dir = init('cancel');
    const base = commit(dir, 'a.txt', 'a\n', 'Base');
    const hooks = join(dir, 'slowhooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    g(dir, 'config', 'core.hooksPath', hooks);
    put(dir, 'b.txt', 'b\n');
    g(dir, 'add', 'b.txt');
    const ac = new AbortController();
    const p = new Repo(dir).commit('Never', { amend: false, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    expect(await kind(p)).toBe('Cancelled');
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
    expect(g(dir, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(porcelain(dir)).toContain('A  b.txt');
  });
});
