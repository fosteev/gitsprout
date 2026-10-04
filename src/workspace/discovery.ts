import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { run } from '../git/run';
import { inside } from './model';

export interface DiscoveredRepo {
  /** Working tree root. */
  root: string;
  /** Resolved git directory (for watchers); follows a `.git` file of a linked worktree. */
  gitDir: string;
  /** Shared git directory (`commondir` of a linked worktree: refs and packed-refs live there); = `gitDir` otherwise. */
  commonDir: string;
  /** The workspace folder the scan found it under. */
  folder: string;
  /** Number of path segments between `folder` and `root` (0 = the folder itself). */
  depth: number;
}

/** Glob (`**`, `*`, `?`, `{a,b}`) over '/'-separated paths relative to the scanned folder. */
export function compileExclude(patterns: readonly string[]): (relPath: string) => boolean {
  const res = patterns.filter(Boolean).map((p) => {
    let re = '';
    let braces = 0;
    const g = p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '{') { braces++; re += '(?:'; }
      else if (c === '}' && braces) { braces--; re += ')'; }
      else if (c === ',' && braces) re += '|';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    if (braces) return /(?!)/; // unbalanced: matches nothing
    return new RegExp(`^${re}$`);
  });
  return (rel) => res.some((r) => r.test(rel));
}

type Marker = { kind: 'repo'; gitDir: string; commonDir: string } | { kind: 'submodule' } | null;

/** `<gitDir>/commondir` of a linked worktree points at the main repo's git dir. */
async function readCommonDir(gitDir: string): Promise<string> {
  try {
    const t = (await fs.readFile(join(gitDir, 'commondir'), 'utf8')).trim();
    return t ? resolve(gitDir, t) : gitDir;
  } catch { return gitDir; }
}

/** What `<dir>/.git` is: a repository, a submodule (skipped) or nothing. */
async function readMarker(dir: string): Promise<Marker> {
  const p = join(dir, '.git');
  let st;
  try { st = await fs.lstat(p); } catch { return null; }
  if (st.isDirectory()) return { kind: 'repo', gitDir: p, commonDir: p };
  if (!st.isFile()) return null;
  let text: string;
  try { text = await fs.readFile(p, 'utf8'); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const target = m[1];
  const gitDir = isAbsolute(target) ? target : resolve(dir, target);
  const commonDir = await readCommonDir(gitDir);
  // A linked worktree has `commondir`; otherwise a git dir under `.git/modules/` belongs to a submodule.
  if (commonDir === gitDir && /\/\.git\/modules\//.test(gitDir.replace(/\\/g, '/') + '/')) return { kind: 'submodule' };
  return { kind: 'repo', gitDir, commonDir };
}

/**
 * Finds git repositories under the workspace folders: up to `depth` levels below a folder (the folder itself is
 * level 0); stops descending once a repo is found; skips dot-dirs, symlinks, `exclude` matches and submodules.
 * The result is sorted by path and has no duplicates (overlapping workspace folders).
 */
export async function discover(folders: readonly string[], depth: number, exclude: readonly string[] = []): Promise<DiscoveredRepo[]> {
  const excluded = compileExclude(exclude);
  const found = new Map<string, DiscoveredRepo>();

  const walk = async (folder: string, dir: string, rel: string, level: number): Promise<void> => {
    const marker = await readMarker(dir);
    if (marker?.kind === 'submodule') return;
    if (marker?.kind === 'repo') {
      if (!found.has(dir)) found.set(dir, { root: dir, gitDir: marker.gitDir, commonDir: marker.commonDir, folder, depth: level });
      return;
    }
    if (level >= depth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (excluded(childRel)) continue;
      await walk(folder, join(dir, e.name), childRel, level + 1);
    }
  };

  for (const f of folders) {
    const root = resolve(f);
    await walk(root, root, '', 0);
  }
  return [...found.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}


/**
 * `discover`, plus: a workspace folder that sits inside a repo (no repo found at or below it) is resolved upwards
 * with `git rev-parse --show-cdup` (cwd = the folder) and the enclosing repo is added (depth 0). `--show-cdup`
 * rather than `--show-toplevel`: the root keeps the folder's spelling (symlinks, `/var` vs `/private/var`, Windows
 * slashes), so it still contains the folder and matches editor paths. Folders in no repo, and submodule checkouts,
 * add nothing.
 */
export async function discoverWithParents(
  folders: readonly string[], depth: number, exclude: readonly string[] = [], gitPath?: string,
): Promise<DiscoveredRepo[]> {
  const found = await discover(folders, depth, exclude);
  const byRoot = new Map(found.map((r) => [r.root, r]));
  for (const f of folders) {
    const folder = resolve(f);
    // Overlapping workspace folders: a repo below this folder may have been attributed to another folder.
    if (found.some((r) => inside(folder, r.root) !== null)) continue;
    let cdup: string;
    try {
      cdup = (await run(folder, ['rev-parse', '--show-cdup'], { gitPath, read: true })).stdout.trim();
    } catch { continue; }
    const top = resolve(folder, cdup);
    if (byRoot.has(top)) continue;
    const marker = await readMarker(top);
    if (marker?.kind !== 'repo') continue;
    byRoot.set(top, { root: top, gitDir: marker.gitDir, commonDir: marker.commonDir, folder, depth: 0 });
  }
  return [...byRoot.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}
