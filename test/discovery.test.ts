import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { compileExclude, discover, discoverWithParents } from '../src/workspace/discovery';

let tmp: string;
const mk = (...p: string[]) => mkdirSync(join(tmp, ...p), { recursive: true });
const gitDir = (...p: string[]) => mk(...p, '.git');
const rel = (rs: { root: string }[]) => rs.map((r) => r.root.slice(tmp.length + 1));

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-disc-')));
  gitDir('ws', 'at', 'alpha');
  gitDir('ws', 'at', 'group', 'beta');            // depth 3
  gitDir('ws', 'at', 'alpha', 'inner');           // nested in a repo: ignored
  gitDir('ws', 'labs', 'gamma');
  gitDir('ws', 'top');                             // top-level repo
  gitDir('ws', 'at', 'x', 'y', 'z', 'deep');       // depth 5: too deep
  gitDir('ws', 'node_modules', 'pkg');
  gitDir('ws', 'vendor', 'lib');
  gitDir('ws', '.hidden', 'repo');
  mk('ws', 'plain', 'empty');
  // submodule: .git file pointing into /modules/
  mk('ws', 'labs', 'sub');
  writeFileSync(join(tmp, 'ws', 'labs', 'sub', '.git'), 'gitdir: ../../.git/modules/sub\n');
  // linked worktree: .git file pointing into /worktrees/ is a repo
  mk('ws', 'labs', 'wt');
  mk('main', '.git', 'worktrees', 'wt');
  writeFileSync(join(tmp, 'ws', 'labs', 'wt', '.git'), `gitdir: ${join(tmp, 'main', '.git', 'worktrees', 'wt')}\n`);
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
      'at/alpha', 'at/group/beta', 'labs/gamma', 'labs/wt', 'top',
    ]);
    expect(found.map((f) => f.depth)).toEqual([2, 3, 2, 2, 1]);
  });

  it('respects a smaller depth', async () => {
    const found = await discover([join(tmp, 'ws')], 2, ['**/node_modules', '**/vendor']);
    expect(rel(found).map((r) => r.slice(3))).toEqual(['at/alpha', 'labs/gamma', 'labs/wt', 'top']);
  });

  it('descends into node_modules and vendor when not excluded', async () => {
    const found = await discover([join(tmp, 'ws')], 3, []);
    expect(rel(found).map((r) => r.slice(3))).toEqual(expect.arrayContaining(['node_modules/pkg', 'vendor/lib']));
  });

  it('resolves the git dir of a linked worktree', async () => {
    const found = await discover([join(tmp, 'ws', 'labs')], 1, []);
    const wt = found.find((f) => f.root.endsWith('wt'))!;
    expect(wt.gitDir).toBe(join(tmp, 'main', '.git', 'worktrees', 'wt'));
    expect(wt.commonDir).toBe(join(tmp, 'main', '.git'));
    expect(found.find((f) => f.root.endsWith('gamma'))!.commonDir).toBe(join(tmp, 'ws', 'labs', 'gamma', '.git'));
    expect(found.find((f) => f.root.endsWith('gamma'))!.gitDir).toBe(join(tmp, 'ws', 'labs', 'gamma', '.git'));
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
    const found = await discover([join(tmp, 'ws'), join(tmp, 'ws', 'labs'), join(tmp, 'nope')], 3, ['**/node_modules', '**/vendor']);
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

describe('discoverWithParents', () => {
  it('resolves a workspace folder inside a repo to the enclosing repo', async () => {
    const root = join(tmp, 'enclosing');
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
    const sub = join(root, 'src', 'deep');
    expect(await discover([sub], 3)).toEqual([]);
    const found = await discoverWithParents([sub], 3);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ root: realpathSync(root), folder: sub, depth: 0 });
    expect(found[0].gitDir).toBe(join(realpathSync(root), '.git'));
  });
  it('does not walk up when something is found below, and adds nothing outside a repo', async () => {
    const withBelow = await discoverWithParents([join(tmp, 'ws', 'at')], 3);
    expect(withBelow.map((r) => r.root)).toEqual((await discover([join(tmp, 'ws', 'at')], 3)).map((r) => r.root));
    mk('nowhere', 'x');
    expect(await discoverWithParents([join(tmp, 'nowhere', 'x')], 3)).toEqual([]);
  });
  it('keeps the folder spelling for the root when the folder is reached through a symlink', async () => {
    const real = join(tmp, 'linked-real');
    mkdirSync(join(real, 'pkg'), { recursive: true });
    execFileSync('git', ['init', '-q', real], { stdio: 'ignore' });
    const link = join(tmp, 'linked');
    symlinkSync(real, link, 'dir');
    const folder = join(link, 'pkg');
    const found = await discoverWithParents([folder], 3);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ root: link, folder, depth: 0 });
    expect(found[0].gitDir).toBe(join(link, '.git'));
  });
  it('does not walk up from a folder whose repo was attributed to an overlapping folder', async () => {
    const home = join(tmp, 'dotfiles');
    mkdirSync(join(home, 'x', 'r'), { recursive: true });
    execFileSync('git', ['init', '-q', home], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', join(home, 'x', 'r')], { stdio: 'ignore' });
    const found = await discoverWithParents([join(home, 'x', 'r'), join(home, 'x')], 3);
    expect(found.map((r) => r.root)).toEqual([join(home, 'x', 'r')]);
  });
  it('never climbs to a repo rooted at the home directory (dotfiles)', async () => {
    const home = join(tmp, 'fakehome');
    mkdirSync(join(home, 'Projects', 'scratch'), { recursive: true });
    execFileSync('git', ['init', '-q', home], { stdio: 'ignore' });
    const folder = join(home, 'Projects', 'scratch');
    expect(await discoverWithParents([folder], 3, [], undefined, home)).toEqual([]);
    // a symlinked spelling of home is the same directory
    const link = join(tmp, 'fakehome-link');
    symlinkSync(home, link, 'dir');
    expect(await discoverWithParents([folder], 3, [], undefined, link)).toEqual([]);
    // any other enclosing repo is still added
    expect((await discoverWithParents([folder], 3, [], undefined, join(tmp, 'elsewhere'))).map((r) => r.root)).toEqual([realpathSync(home)]);
  });
});
