import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import type { SummaryStatus, Worktree } from '../git/types';
import type { Registry } from '../workspace/registry';
import { currentWorktrees, worktreeContext, worktreeDescription, worktreeIcon, worktreeLabel } from './worktreeModel';

/** At most this many `status` reads per refresh for worktrees the registry does not know. */
const MAX_SUMMARY_READS = 10;
const DEBOUNCE_MS = 100;

export interface WorktreeNode { kind: 'worktree'; worktree: Worktree; summary?: SummaryStatus; current: boolean }

/** Worktrees tree: every worktree of the active repo; a click opens its graph. */
export class WorktreesView implements vscode.TreeDataProvider<WorktreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<WorktreeNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly registry: Registry, private readonly log: (m: string) => void) {
    this.view = vscode.window.createTreeView('gitsprout.worktrees', { treeDataProvider: this });
    this.disposables.push(
      this.emitter, this.view,
      registry.onDidChangeActive(() => this.refresh()),
      registry.onDidChangeRepos(() => this.refresh()),
      // A sibling worktree's own status change (its commit, its staging) updates its row here.
      registry.onDidChangeRepo((root) => { if (this.sameFamily(root)) this.refresh(); }),
      registry.onDidRefreshRepo((root) => { if (root === this.registry.active?.root) this.refresh(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  /** `root` is the active repo or another worktree of it (same main worktree): other repos don't touch this list. */
  private sameFamily(root: string): boolean {
    const active = this.registry.active;
    const r = this.registry.get(root);
    if (!active || !r) return false;
    return (r.worktreeOf ?? r.root) === (active.worktreeOf ?? active.root);
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), DEBOUNCE_MS);
  }

  async getChildren(el?: WorktreeNode): Promise<WorktreeNode[]> {
    if (el) return [];
    const active = this.registry.active;
    if (!active) return [];
    let list: Worktree[];
    try {
      list = await new Repo(active.root, this.registry.gitPath).worktrees();
    } catch (e) {
      this.log(`worktrees ${active.root}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    const current = currentWorktrees(list, (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    let reads = 0;
    const nodes = await Promise.all(list.map(async (w): Promise<WorktreeNode> => {
      const node: WorktreeNode = { kind: 'worktree', worktree: w, current: current.has(w.path) };
      if (w.bare || w.prunable !== null) return node;
      const known = this.registry.get(w.path);
      if (known) return { ...node, summary: known };
      if (reads >= MAX_SUMMARY_READS) return node;
      reads++;
      try { node.summary = await new Repo(w.path, this.registry.gitPath).summary(); } catch { /* no status for this row */ }
      return node;
    }));
    return nodes;
  }

  getTreeItem(el: WorktreeNode): vscode.TreeItem {
    const w = el.worktree;
    const item = new vscode.TreeItem(worktreeLabel(w), vscode.TreeItemCollapsibleState.None);
    item.id = `worktree:${w.path}`;
    item.description = worktreeDescription(w, el.summary);
    item.tooltip = [w.path, w.locked ? `Locked: ${w.locked}` : '', w.prunable ? `Missing on disk (${w.prunable})` : ''].filter(Boolean).join('\n');
    item.contextValue = worktreeContext(w, el.current);
    item.iconPath = new vscode.ThemeIcon(worktreeIcon(w), el.current ? new vscode.ThemeColor('charts.green') : undefined);
    // A missing or bare worktree has no graph to open; the menu offers Prune instead.
    if (w.prunable === null && !w.bare) item.command = { command: 'gitsprout.worktreeOpenGraph', title: 'Open Graph', arguments: [w.path] };
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
