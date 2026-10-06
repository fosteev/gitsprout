import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo';
import { GitError } from '../src/git/types';

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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-wt-')));
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

/** Main repo on `main` with two commits, a branch `feat` and a clean-state folder for worktrees. */
function setup() {
  const main = init('main');
  commit(main, 'a.txt', 'a\n', 'one');
  commit(main, 'b.txt', 'b\n', 'two');
  g(main, 'branch', 'feat');
  return { main, repo: new Repo(main), wt: (name: string) => join(fresh('wt'), name) };
}
const kind = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e) => (e instanceof GitError ? e.kind : String(e)));

describe('worktrees', () => {
  it('lists the main worktree first', async () => {
    const { main, repo } = setup();
    const list = await repo.worktrees();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: main, branch: 'main', main: true, bare: false, locked: null, prunable: null });
    expect(list[0].head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('adds a worktree for an existing branch, a new branch, a remote branch and a detached commit', async () => {
    const { main, repo, wt } = setup();
    const origin = fresh('origin');
    g(origin, 'init', '-q', '--bare', '-b', 'main');
    g(main, 'remote', 'add', 'origin', origin);
    g(main, 'push', '-q', 'origin', 'main:main', 'main:remote-only');
    g(main, 'fetch', '-q', 'origin');
    const sha = g(main, 'rev-parse', 'HEAD~1').trim();

    const p1 = wt('existing'); const p2 = wt('new'); const p3 = wt('tracked'); const p4 = wt('detached');
    await repo.addWorktree({ path: p1, branch: 'feat' });
    await repo.addWorktree({ path: p2, newBranch: 'topic', base: 'main' });
    await repo.addWorktree({ path: p3, track: 'origin/remote-only', newBranch: 'remote-only' });
    await repo.addWorktree({ path: p4, detach: sha });

    const list = await repo.worktrees();
    const by = (p: string) => list.find((w) => w.path === realpathSync(p));
    expect(list).toHaveLength(5);
    expect(by(p1)).toMatchObject({ branch: 'feat', main: false });
    expect(by(p2)).toMatchObject({ branch: 'topic' });
    expect(by(p3)).toMatchObject({ branch: 'remote-only' });
    expect(by(p4)).toMatchObject({ branch: null, head: sha });
    expect(g(p3, 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}').trim()).toBe('origin/remote-only');
  });

  it('refs() reports the worktree of a branch (the current root included)', async () => {
    const { main, repo, wt } = setup();
    const p = wt('feat');
    await repo.addWorktree({ path: p, branch: 'feat' });
    g(main, 'branch', 'idle');
    const { locals } = await repo.refs();
    const wtOf = (n: string) => locals.find((b) => b.name === n)?.worktree;
    expect(wtOf('main')).toBe(main);
    expect(wtOf('feat')).toBe(realpathSync(p));
    expect(wtOf('idle')).toBeNull();
  });

  it('checkout and branch -d of a branch used by a worktree are CheckedOutElsewhere', async () => {
    const { repo, wt } = setup();
    await repo.addWorktree({ path: wt('feat'), branch: 'feat' });
    expect(await kind(repo.checkout('feat'))).toBe('CheckedOutElsewhere');
    expect(await kind(repo.deleteBranch('feat', false))).toBe('CheckedOutElsewhere');
    await expect(repo.addWorktree({ path: wt('again'), branch: 'feat' })).rejects.toMatchObject({ kind: 'CheckedOutElsewhere' });
  });

  it('removes a clean worktree; a dirty one needs force', async () => {
    const { repo, wt } = setup();
    const clean = wt('clean'); const dirty = wt('dirty');
    await repo.addWorktree({ path: clean, newBranch: 'c', base: 'main' });
    await repo.addWorktree({ path: dirty, newBranch: 'd', base: 'main' });
    await repo.removeWorktree(clean, false);
    expect(existsSync(clean)).toBe(false);

    put(dirty, 'new.txt', 'x\n');
    expect(await kind(repo.removeWorktree(dirty, false))).toBe('WorktreeDirty');
    expect(existsSync(dirty)).toBe(true);
    await repo.removeWorktree(dirty, true);
    expect(existsSync(dirty)).toBe(false);
    expect(await repo.worktrees()).toHaveLength(1);
  });

  it('a locked worktree is WorktreeLocked, also with force; unlock lets it go', async () => {
    const { main, repo, wt } = setup();
    const p = wt('locked');
    await repo.addWorktree({ path: p, newBranch: 'l', base: 'main' });
    g(main, 'worktree', 'lock', '--reason', 'usb', p);
    expect((await repo.worktrees()).find((w) => w.branch === 'l')?.locked).toBe('usb');
    expect(await kind(repo.removeWorktree(p, false))).toBe('WorktreeLocked');
    expect(await kind(repo.removeWorktree(p, true))).toBe('WorktreeLocked');
    await repo.unlockWorktree(p);
    expect((await repo.worktrees()).find((w) => w.branch === 'l')?.locked).toBeNull();
    await repo.removeWorktree(p, false);
    expect(existsSync(p)).toBe(false);
  });

  it('a folder deleted by hand is prunable (missing); prune drops it', async () => {
    const { repo, wt } = setup();
    const p = wt('gone');
    await repo.addWorktree({ path: p, newBranch: 'g', base: 'main' });
    rmSync(p, { recursive: true, force: true });
    const gone = (await repo.worktrees()).find((w) => w.branch === 'g');
    expect(gone?.prunable).toBeTruthy();
    await repo.pruneWorktrees();
    const list = await repo.worktrees();
    expect(list).toHaveLength(1);
    expect(list.some((w) => w.branch === 'g')).toBe(false);
  });
});
