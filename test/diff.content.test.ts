import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTarget } from '../src/diff/content';
import { commitFilePlan, stagedPlan, stashFilePlan, unstagedPlan, type DiffPlan, type Side } from '../src/diff/uri';
import { Repo } from '../src/git/repo';

// A real repo in a temp dir, isolated from the user's git config. Every plan is resolved to text like the provider does.
let tmp: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (f: string, c: string) => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), c); };

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-diff-')));
  Object.assign(ENV, { HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'gc') });
  for (const k of [...Object.keys(ENV), 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) { saved[k] = process.env[k]; if (k in ENV) process.env[k] = ENV[k]; else delete process.env[k]; }
  writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
  repo = join(tmp, 'r');
  mkdirSync(repo);
  g('init', '-q', '-b', 'main');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.hooksPath', join(tmp, 'no-hooks'));
});
afterAll(() => {
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

async function sides(plan: DiffPlan): Promise<[string, string]> {
  if (plan.kind !== 'diff') throw new Error('not a diff');
  const text = (s: Side) => (s.kind === 'file' ? readFileSync(join(repo, s.path), 'utf8') : readTarget({ root: repo, ref: s.ref, path: s.path }));
  return [await text(plan.left), await text(plan.right)];
}

describe('diff content on a temp repo', () => {
  it('resolves the sides of every plan kind', async () => {
    const r = new Repo(repo);
    // unborn: staged add has an empty left
    put('a.txt', 'one\n');
    g('add', 'a.txt');
    const st0 = (await r.status()).staged[0];
    expect(await sides(stagedPlan(st0, true))).toEqual(['', 'one\n']);
    g('commit', '-q', '-m', 'first');
    const first = g('rev-parse', 'HEAD').trim();

    // commit: modify, add, rename, delete
    put('a.txt', 'two\n'); put('b.txt', 'bee\n'); put('old/name.txt', 'moved content that is long enough to rename\n');
    g('add', '-A'); g('commit', '-q', '-m', 'second');
    put('a.txt', 'three\n');
    g('mv', 'old/name.txt', 'new-name.txt'); g('rm', '-q', 'b.txt'); g('add', '-A'); g('commit', '-q', '-m', 'third');
    const third = g('rev-parse', 'HEAD').trim();
    const files = await r.commitFiles(third);
    const by = (p: string) => files.find((f) => f.path === p)!;
    expect(await sides(commitFilePlan(third, by('a.txt'), `${third}^`))).toEqual(['two\n', 'three\n']);
    expect(await sides(commitFilePlan(third, by('b.txt'), `${third}^`))).toEqual(['bee\n', '']);
    const ren = by('new-name.txt');
    expect(ren.status).toBe('R');
    expect(await sides(commitFilePlan(third, ren, `${third}^`))).toEqual(['moved content that is long enough to rename\n', 'moved content that is long enough to rename\n']);
    expect(await sides(commitFilePlan(first, { path: 'a.txt', origPath: null, status: 'A' }))).toEqual(['', 'one\n']);

    // working tree + index
    put('a.txt', 'staged\n'); g('add', 'a.txt'); put('a.txt', 'worktree\n'); put('u.txt', 'untracked\n');
    const status = await r.status();
    expect(await sides(stagedPlan(status.staged[0], false))).toEqual(['three\n', 'staged\n']);
    expect(await sides(unstagedPlan(status.unstaged.find((f) => f.path === 'a.txt')!))).toEqual(['staged\n', 'worktree\n']);
    expect(unstagedPlan(status.unstaged.find((f) => f.path === 'u.txt')!)).toEqual({ kind: 'open', path: 'u.txt' });

    // stash: tracked change and an untracked file
    g('stash', 'push', '-q', '-u', '-m', 'wip');
    const sf = await r.stashFiles(0);
    const tracked = sf.find((f) => f.path === 'a.txt')!;
    const untr = sf.find((f) => f.path === 'u.txt')!;
    expect(untr.untracked).toBe(true);
    const [wip] = await r.stashes();
    expect(await sides(stashFilePlan(wip, tracked))).toEqual(['three\n', 'worktree\n']);
    expect(await sides(stashFilePlan(wip, untr))).toEqual(['', 'untracked\n']);
    // a newer stash shifts the index; the plan still points at the same stash commit
    put('a.txt', 'newer\n'); g('stash', 'push', '-q', '-m', 'newer');
    const shifted = (await r.stashes()).find((s) => s.sha === wip.sha)!;
    expect(shifted.index).toBe(1);
    expect(await sides(stashFilePlan(shifted, tracked))).toEqual(['three\n', 'worktree\n']);
    expect(stashFilePlan(shifted, tracked)).toMatchObject({ title: 'a.txt (stash@{1})' });
    // files are read by the stash sha, so a shifted index does not change them
    expect(await r.stashFiles(wip.sha)).toEqual(sf);
  });

  it('shows a placeholder for binary blobs', async () => {
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff, 0x00, 0x42]));
    g('add', 'bin.dat'); g('commit', '-q', '-m', 'bin');
    const oid = g('rev-parse', 'HEAD:bin.dat').trim();
    expect(await readTarget({ root: repo, ref: 'HEAD', path: 'bin.dat' })).toBe(`Binary file ${oid.slice(0, 7)} (7 bytes)\n`);
    expect(await readTarget({ root: repo, ref: ':', path: 'bin.dat' })).toBe(`Binary file ${oid.slice(0, 7)} (7 bytes)\n`);
  });

  it('missing refs and paths yield an empty document', async () => {
    expect(await readTarget({ root: repo, ref: 'HEAD', path: 'nope.txt' })).toBe('');
    expect(await readTarget({ root: repo, ref: '', path: 'a.txt' })).toBe('');
    expect(await readTarget({ root: repo, ref: ':', path: 'nope.txt' })).toBe('');
  });
});
