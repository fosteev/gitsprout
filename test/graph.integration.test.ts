import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo';
import { layout, visibleRows } from '../webview/layout';
import { keepSet, refsBySha } from '../webview/render';

// The data path of the panel (log + refs + status → rows → lanes) on a real repo with a merge and CI commits.
let tmp: string;
let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};
const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-graph-')));
  Object.assign(ENV, { HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'gc') });
  for (const k of [...Object.keys(ENV), 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) { saved[k] = process.env[k]; if (k in ENV) process.env[k] = ENV[k]; else delete process.env[k]; }
  writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
  dir = join(tmp, 'r');
  mkdirSync(dir);
  g('init', '-q', '-b', 'main');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.hooksPath', join(tmp, 'no-hooks'));
});
afterAll(() => {
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('graph data path on a temp repo', () => {
  it('lays out a merge with CI commits and closes every lane at the root', async () => {
    const commit = (msg: string, file: string) => { writeFileSync(join(dir, file), msg); g('add', file); g('commit', '-q', '-m', msg); };
    commit('root', 'a');
    g('switch', '-q', '-c', 'feature');
    commit('feature work', 'f');
    commit('AutoBuild', 'ci1');
    g('switch', '-q', 'main');
    commit('main work', 'm');
    g('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    commit('AutoBuild', 'ci2');
    g('tag', 'v1');
    writeFileSync(join(dir, 'dirty'), 'x');

    const repo = new Repo(dir);
    const [commits, refs, status] = await Promise.all([repo.log(100), repo.refs(), repo.status()]);
    expect(commits).toHaveLength(6);
    const pills = refsBySha(refs, refs.head);
    const keep = keepSet(pills, refs.head);
    const isCi = (c: { subject: string }) => c.subject === 'AutoBuild';

    const all = visibleRows(commits, { hideCi: false, isCi, keep, headSha: refs.head.sha, dirty: status.unstaged.length > 0 });
    expect(all.rows[0].wip).toBe(true);
    expect(all.rows).toHaveLength(7);
    const lay = layout(all.rows);
    expect(lay.max).toBe(2);
    const last = lay.rows[lay.rows.length - 1];
    expect(last.parents).toEqual([]);
    expect(last.outs).toEqual([]);
    // nothing is awaited after the root: every lane that was open at the top got closed
    expect(last.before.filter((v) => v !== null).every((v) => v === last.sha)).toBe(true);

    // HEAD (ci2) carries main + the tag: kept even though it is a CI commit; feature's tip ci1 is kept by the branch
    const hidden = visibleRows(commits, { hideCi: true, isCi, keep, headSha: refs.head.sha, dirty: false });
    expect(hidden.hiddenN).toBe(0);
    expect(hidden.rows).toHaveLength(6);
    // without refs on them, they would go
    const noKeep = visibleRows(commits, { hideCi: true, isCi, keep: new Set(), headSha: refs.head.sha, dirty: false });
    expect(noKeep.hiddenN).toBe(2);
    const l2 = layout(noKeep.rows);
    expect(l2.rows.every((r) => r.parents.every((p) => noKeep.rows.some((x) => x.sha === p)))).toBe(true);
  });
});
