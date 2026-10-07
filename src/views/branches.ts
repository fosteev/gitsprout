import * as vscode from 'vscode';
import { branchContext, checkedOutElsewhere, branchDescription, buildBranchTree, short, type BranchLeaf, type BranchNode } from './refsModel';
import { CURRENT_COLOR, CURRENT_URI } from './currentMark';
import { createRefTree, REVEAL_CMD, type RefsStore } from './refsStore';
import type { Registry } from '../workspace/registry';

/** Branches: locals grouped by the first `/` segment; HEAD has a green check and a green label. Commands receive the `BranchLeaf`. */
export class BranchesView implements vscode.TreeDataProvider<BranchNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: RefsStore) {}

  getChildren(el?: BranchNode): BranchNode[] {
    if (el) return el.kind === 'folder' ? el.children : [];
    if (!this.store.refs) return [];
    return buildBranchTree(this.store.refs.locals, this.store.refs.head.branch);
  }

  getTreeItem(n: BranchNode): vscode.TreeItem {
    const root = this.store.repo?.root ?? '';
    if (n.kind === 'folder') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${root}|${n.key}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${root}|${n.key}`;
    item.iconPath = n.isHead ? new vscode.ThemeIcon('check', CURRENT_COLOR) : new vscode.ThemeIcon('git-branch');
    if (n.isHead) item.resourceUri = CURRENT_URI;
    item.description = branchDescription(n.branch, root, n.isHead);
    item.contextValue = branchContext(n.isHead, checkedOutElsewhere(n.branch, root, n.isHead));
    item.tooltip = `${n.branch.name} · ${short(n.branch.sha)}${n.branch.upstream ? ` → ${n.branch.upstream}` : ''}`;
    item.command = { command: REVEAL_CMD, title: 'Reveal in Graph', arguments: [n.branch.sha] };
    return item;
  }

  refresh(): void { this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }
}

export function createBranchesView(store: RefsStore, registry: Registry): vscode.Disposable {
  const provider = new BranchesView(store);
  const view = createRefTree('branches', provider, store, registry);
  return vscode.Disposable.from(view, provider, store.onDidChange(() => provider.refresh()));
}
export type { BranchLeaf };
