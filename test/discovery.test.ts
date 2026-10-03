import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileExclude, discover } from '../src/workspace/discovery';

let tmp: string;
const mk = (...p: string[]) => mkdirSync(join(tmp, ...p), { recursive: true });
const gitDir = (...p: string[]) => mk(...p, '.git');
const rel = (rs: { root: string }[]) => rs.map((r) => r.root.slice(tmp.length + 1));

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-disc-')));
  gitDir('ws', 'at', 'alpha');
  gitDir('ws', 'at', 'group', 'beta');            // depth 3
  gitDir('ws', 'at', 'alpha', 'inner');           // nested in a repo: ignored
  gitDir('ws', 'pilot', 'gamma');
  gitDir('ws', 'top');                             // top-level repo
  gitDir('ws', 'at', 'x', 'y', 'z', 'deep');       // depth 5: too deep
  gitDir('ws', 'node_modules', 'pkg');
  gitDir('ws', 'vendor', 'lib');
  gitDir('ws', '.hidden', 'repo');
  mk('ws', 'plain', 'empty');
  // submodule: .git file pointing into /modules/
  mk('ws', 'pilot', 'sub');
  writeFileSync(join(tmp, 'ws', 'pilot', 'sub', '.git'), 'gitdir: ../../.git/modules/sub\n');
  // linked worktree: .git file pointing into /worktrees/ is a repo
  mk('ws', 'pilot', 'wt');
  mk('main', '.git', 'worktrees', 'wt');
  writeFileSync(join(tmp, 'ws', 'pilot', 'wt', '.git'), `gitdir: ${join(tmp, 'main', '.git', 'worktrees', 'wt')}\n`);
  writeFileSync(join(tmp, 'main', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  // symlink to a repo elsewhere: skipped
  gitDir('elsewhere');
  symlinkSync(join(tmp, 'elsewhere'), join(tmp, 'ws', 'link'));
  // a folder that is itself a repo, with a repo inside
  gitDir('single');
  gitDir('single', 'child');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('discover', () => {
  it('finds repos to the depth, ignores nested/excluded/hidden/submodule/symlink', async () => {
    const found = await discover([join(tmp, 'ws')], 3, ['**/node_modules', '**/vendor']);
    expect(rel(found).map((r) => r.slice(3))).toEqual([
      'at/alpha', 'at/group/beta', 'pilot/gamma', 'pilot/wt', 'top',
    ]);
    expect(found.map((f) => f.depth)).toEqual([2, 3, 2, 2, 1]);
  });

  it('respects a smaller depth', async () => {
    const found = await discover([join(tmp, 'ws')], 2, ['**/node_modules', '**/vendor']);
    expect(rel(found).map((r) => r.slice(3))).toEqual(['at/alpha', 'pilot/gamma', 'pilot/wt', 'top']);
  });

  it('descends into node_modules and vendor when not excluded', async () => {
    const found = await discover([join(tmp, 'ws')], 3, []);
    expect(rel(found).map((r) => r.slice(3))).toEqual(expect.arrayContaining(['node_modules/pkg', 'vendor/lib']));
  });

  it('resolves the git dir of a linked worktree', async () => {
    const found = await discover([join(tmp, 'ws', 'pilot')], 1, []);
    const wt = found.find((f) => f.root.endsWith('wt'))!;
    expect(wt.gitDir).toBe(join(tmp, 'main', '.git', 'worktrees', 'wt'));
    expect(wt.commonDir).toBe(join(tmp, 'main', '.git'));
    expect(found.find((f) => f.root.endsWith('gamma'))!.commonDir).toBe(join(tmp, 'ws', 'pilot', 'gamma', '.git'));
    expect(found.find((f) => f.root.endsWith('gamma'))!.gitDir).toBe(join(tmp, 'ws', 'pilot', 'gamma', '.git'));
  });

  it('treats a workspace folder that is a repo as depth 0 and stops there', async () => {
    const found = await discover([join(tmp, 'single')], 3, []);
    expect(found.map((f) => [f.root, f.depth])).toEqual([[join(tmp, 'single'), 0]]);
  });

  it('tells a worktree of a repo under a "modules" folder from a submodule', async () => {
    mk('mods', 'modules', 'main', '.git', 'worktrees', 'w');
    writeFileSync(join(tmp, 'mods', 'modules', 'main', '.git', 'worktrees', 'w', 'commondir'), '../..\n');
    mk('mods', 'ws', 'w');
    writeFileSync(join(tmp, 'mods', 'ws', 'w', '.git'), `gitdir: ${join(tmp, 'mods', 'modules', 'main', '.git', 'worktrees', 'w')}\n`);
    mk('mods', 'ws', 'nested', 'sub');
    writeFileSync(join(tmp, 'mods', 'ws', 'nested', 'sub', '.git'), 'gitdir: ../../../modules/main/.git/modules/sub\n');
    const found = await discover([join(tmp, 'mods', 'ws')], 3, []);
    expect(found.map((f) => [f.root, f.commonDir])).toEqual([[join(tmp, 'mods', 'ws', 'w'), join(tmp, 'mods', 'modules', 'main', '.git')]]);
  });

  it('skips unreadable directories without failing the scan', async () => {
    mk('locked', 'inner');
    gitDir('locked', 'inner', 'repo');
    gitDir('locked', 'ok');
    chmodSync(join(tmp, 'locked', 'inner'), 0o000);
    try {
      const found = await discover([join(tmp, 'locked')], 3, []);
      expect(found.map((f) => f.root)).toEqual([join(tmp, 'locked', 'ok')]);
    } finally {
      chmodSync(join(tmp, 'locked', 'inner'), 0o755);
    }
  });

  it('dedupes overlapping folders and tolerates missing ones', async () => {
    const found = await discover([join(tmp, 'ws'), join(tmp, 'ws', 'pilot'), join(tmp, 'nope')], 3, ['**/node_modules', '**/vendor']);
    expect(found.filter((f) => f.root.endsWith('gamma'))).toHaveLength(1);
  });
});

describe('compileExclude', () => {
  it('matches **/name at any depth, but not partial names', () => {
    const ex = compileExclude(['**/node_modules', 'build/*', 'a?c']);
    expect(ex('node_modules')).toBe(true);
    expect(ex('x/y/node_modules')).toBe(true);
    expect(ex('x/node_modules_old')).toBe(false);
    expect(ex('build/out')).toBe(true);
    expect(ex('build/out/deep')).toBe(false);
    expect(ex('abc')).toBe(true);
    expect(ex('a/c')).toBe(false);
  });

  it('supports {a,b} alternation like VS Code globs', () => {
    const ex = compileExclude(['**/{node_modules,vendor}']);
    expect(ex('x/vendor')).toBe(true);
    expect(ex('node_modules')).toBe(true);
    expect(ex('x/vendors')).toBe(false);
    expect(compileExclude(['{a,b'])('a')).toBe(false);
  });
});
