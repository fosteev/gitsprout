import * as vscode from 'vscode';
import type { Registry } from '../workspace/registry';
import { buildRepoTree, repoDescription, repoTooltip, viewDescription, type RepoTreeNode } from './repoModel';

const FILTER_KEY = 'gitsprout.onlyAttention';
/** Internal (not contributed): a click on a repo row. Selection events alone miss a click on the already selected row. */
const ACTIVATE_CMD = 'gitsprout._activateRepository';

/** Repositories tree: groups → sub-folders → repos; selecting a repo makes it the active one. */
export class RepositoriesView implements vscode.TreeDataProvider<RepoTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<RepoTreeNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private roots: RepoTreeNode[] = [];
  private parents = new Map<string, RepoTreeNode | undefined>();
  private byKey = new Map<string, RepoTreeNode>();
  private onlyAttention: boolean;

  constructor(private readonly registry: Registry, private readonly state: vscode.Memento) {
    this.onlyAttention = state.get<boolean>(FILTER_KEY, false);
    this.view = vscode.window.createTreeView('gitsprout.repositories', { treeDataProvider: this, showCollapseAll: true });
    void vscode.commands.executeCommand('setContext', FILTER_KEY, this.onlyAttention);
    this.rebuild();
    this.disposables.push(
      this.emitter, this.view,
      vscode.commands.registerCommand(ACTIVATE_CMD, (root: string) => registry.setActive(root)),
      registry.onDidChangeRepos(() => this.refresh()),
      registry.onDidChangeRepo(() => this.refresh()),
      registry.onDidChangeActive((r) => { this.refresh(); if (r) this.reveal(r.root); }),
      this.view.onDidChangeSelection((e) => {
        const n = e.selection[0];
        if (n?.kind === 'repo') registry.setActive(n.repo.root);
      }),
    );
  }

  get filtered(): boolean { return this.onlyAttention; }

  setOnlyAttention(on: boolean): void {
    this.onlyAttention = on;
    void this.state.update(FILTER_KEY, on);
    void vscode.commands.executeCommand('setContext', FILTER_KEY, on);
    this.refresh();
  }

  toggleOnlyAttention(): void { this.setOnlyAttention(!this.onlyAttention); }

  private rebuild(): void {
    const repos = this.registry.repos;
    this.roots = buildRepoTree(repos, { onlyAttention: this.onlyAttention, activeRoot: this.registry.active?.root });
    this.parents.clear();
    this.byKey.clear();
    const index = (nodes: RepoTreeNode[], parent?: RepoTreeNode) => {
      for (const n of nodes) {
        this.parents.set(n.key, parent);
        this.byKey.set(n.key, n);
        if (n.kind !== 'repo') index(n.children, n);
      }
    };
    index(this.roots);
    this.view.description = viewDescription(repos, this.onlyAttention);
  }

  private refresh(): void {
    this.rebuild();
    this.emitter.fire();
  }

  private reveal(root: string): void {
    if (!this.view.visible) return;
    const n = this.byKey.get(`repo:${root}`);
    if (n) void Promise.resolve(this.view.reveal(n, { select: true, focus: false })).then(undefined, () => undefined);
  }

  getChildren(el?: RepoTreeNode): RepoTreeNode[] {
    if (!el) return this.roots;
    return el.kind === 'repo' ? [] : el.children;
  }

  getParent(el: RepoTreeNode): RepoTreeNode | undefined { return this.parents.get(el.key); }

  getTreeItem(el: RepoTreeNode): vscode.TreeItem {
    if (el.kind !== 'repo') {
      const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = el.key;
      item.description = el.description;
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const r = el.repo;
    const active = r.root === this.registry.active?.root;
    const item = new vscode.TreeItem(r.name, vscode.TreeItemCollapsibleState.None);
    item.id = el.key;
    item.description = repoDescription(r);
    item.tooltip = repoTooltip(r);
    item.contextValue = 'repo';
    item.command = { command: ACTIVATE_CMD, title: 'Make Active', arguments: [r.root] };
    item.iconPath = new vscode.ThemeIcon('repo', active ? new vscode.ThemeColor('charts.green') : undefined);
    return item;
  }

  dispose(): void { for (const d of this.disposables) d.dispose(); }
}
