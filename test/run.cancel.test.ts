import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo';
import { run } from '../src/git/run';
import { GitError, type RepoSummary } from '../src/git/types';
import { fetchRepos, summarizeFetch } from '../src/workspace/fetch';

// A fake "git" that hangs, standing in for a fetch stuck on a dead remote.
let tmp: string;
let hang: string;
let spawner: string;
let pidFile: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-cancel-')));
  hang = join(tmp, 'git-hang');
  writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(hang, 0o755);
  // Like `git fetch --all` / ssh: a child that would outlive a kill of the parent alone.
  pidFile = join(tmp, 'child.pid');
  spawner = join(tmp, 'git-spawner');
  writeFileSync(spawner, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);
  chmodSync(spawner, 0o755);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const kindOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e) => (e instanceof GitError ? e.kind : String(e)));

describe('run: abort and timeout', () => {
  it('an abort kills the process and rejects with Cancelled', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = kindOf(run(tmp, ['fetch'], { gitPath: hang, signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    expect(await p).toBe('Cancelled');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('an already aborted signal never starts git', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await kindOf(run(tmp, ['fetch'], { gitPath: hang, signal: ac.signal }))).toBe('Cancelled');
  });
  it('a timeout kills git and reports it as a normal error, not a cancellation', async () => {
    const e = await run(tmp, ['fetch'], { gitPath: hang, timeout: 100 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitError);
    expect((e as GitError).kind).toBe('Other');
    expect((e as GitError).message).toMatch(/timed out/);
  });
  it.skipIf(process.platform === 'win32')('an abort also kills what git spawned (process group)', async () => {
    const ac = new AbortController();
    const p = kindOf(run(tmp, ['fetch'], { gitPath: spawner, signal: ac.signal }));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    ac.abort();
    expect(await p).toBe('Cancelled');
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });
  it('Repo.fetch threads the signal through', async () => {
    const ac = new AbortController();
    const p = kindOf(new Repo(tmp, hang).fetch({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    expect(await p).toBe('Cancelled');
    expect(await kindOf(new Repo(tmp, hang).fetch({ timeoutMs: 100 }))).toBe('Other');
  });
});

describe('fetchRepos: cancelled fetches', () => {
  const mk = (name: string): RepoSummary => ({ root: `/r/${name}`, name, relPath: name, group: '', branch: 'main', sha: 'a', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 });
  it('counts a killed fetch as skipped, not as a failure', async () => {
    const repos = [mk('a'), mk('b'), mk('c')];
    const ac = new AbortController();
    let finished = 0;
    const { outcomes, skipped } = await fetchRepos(repos, 3, async (r, signal) => {
      if (r.name === 'a') return;
      if (r.name === 'b') throw new GitError('Other', 'boom', '', []);
      await new Promise<void>((_, rej) => signal?.addEventListener('abort', () => rej(new GitError('Cancelled', 'Cancelled', '', []))));
    }, { signal: ac.signal, onDone: () => { if (++finished === 2) ac.abort(); } });
    expect(outcomes.map((o) => [o.name, o.ok])).toEqual([['a', true], ['b', false]]);
    expect(skipped).toBe(1);
    const sum = summarizeFetch(outcomes, repos, skipped);
    expect(sum.text).toContain('Cancelled, 1 not fetched.');
    expect(sum.text).toContain('1 failed: b (boom)');
  });
});
