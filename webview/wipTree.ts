// Pure model of the WIP file tree (no DOM): folders first, single-child folder chains compacted like VS Code's compact folders.
import type { FileChange } from '../src/git/types';

export interface TreeFile {
  kind: 'file';
  /** Last path segment (a nested repository keeps its trailing `/`). */
  name: string;
  file: FileChange;
  /** Position in the list the tree was built from (the row's `data-file`). */
  index: number;
}

export interface TreeDir {
  kind: 'dir';
  /** Full path of the deepest folder of a compacted chain (`pulse/widgets`); '' for the root. */
  path: string;
  /** What the row shows (`pulse/widgets`). */
  label: string;
  children: TreeNode[];
}

export type TreeNode = TreeDir | TreeFile;

interface Raw { dirs: Map<string, Raw>; files: TreeFile[] }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function convert(raw: Raw, base: string): TreeNode[] {
  const dirs: TreeDir[] = [...raw.dirs.keys()].sort(cmp).map((name) => {
    let label = name;
    let path = base ? `${base}/${name}` : name;
    let cur = raw.dirs.get(name) as Raw;
    while (!cur.files.length && cur.dirs.size === 1) {
      const [k, next] = [...cur.dirs][0];
      label += `/${k}`;
      path += `/${k}`;
      cur = next;
    }
    return { kind: 'dir', path, label, children: convert(cur, path) };
  });
  const files = [...raw.files].sort((a, b) => cmp(a.name, b.name) || cmp(a.file.path, b.file.path));
  return [...dirs, ...files];
}

/** The tree of one list (unstaged or staged). Folders sort before files, each by name (code-point order, stable across locales). */
export function buildTree(files: readonly FileChange[]): TreeDir {
  const root: Raw = { dirs: new Map(), files: [] };
  files.forEach((file, index) => {
    const trailing = file.path.endsWith('/');
    const parts = (trailing ? file.path.slice(0, -1) : file.path).split('/');
    const last = parts.pop() as string;
    let n = root;
    for (const p of parts) {
      let d = n.dirs.get(p);
      if (!d) { d = { dirs: new Map(), files: [] }; n.dirs.set(p, d); }
      n = d;
    }
    n.files.push({ kind: 'file', name: trailing ? `${last}/` : last, file, index });
  });
  return { kind: 'dir', path: '', label: '', children: convert(root, '') };
}

/** Paths of every folder row of a tree (nested ones included): what Collapse All / Expand All act on. */
export function dirPaths(tree: TreeDir): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]): void => { for (const n of nodes) if (n.kind === 'dir') { out.push(n.path); walk(n.children); } };
  walk(tree.children);
  return out;
}
