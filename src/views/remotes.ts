import * as vscode from 'vscode';
import type { Registry } from '../workspace/registry';
import { buildRemoteTree, short, type RemoteGroup, type RemoteLeaf } from './refsModel';
import { createRefTree, REVEAL_CMD, type RefsStore } from './refsStore';

type RemoteNode = RemoteGroup | RemoteLeaf;

/** Remotes: one node per remote with its branches. Commands receive the `RemoteLeaf` (`ref.name` = `origin/develop`). */
export class RemotesView implements vscode.TreeDataProvider<RemoteNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: RefsStore) {}

  getChildren(el?: RemoteNode): RemoteNode[] {
    if (el) return el.kind === 'remote' ? el.children : [];
    return this.store.refs ? buildRemoteTree(this.store.refs.remotes) : [];
  }

  getTreeItem(n: RemoteNode): vscode.TreeItem {
    const root = this.store.repo?.root ?? '';
    if (n.kind === 'remote') {
      const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${root}|${n.key}`;
      item.iconPath = new vscode.ThemeIcon('cloud');
      item.description = `${n.children.length}`;
      return item;
    }
    const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${root}|${n.key}`;
    item.iconPath = new vscode.ThemeIcon('git-branch');
    item.description = short(n.ref.sha);
    item.contextValue = 'branch.remote';
    item.tooltip = `${n.ref.name} · ${short(n.ref.sha)}`;
    item.command = { command: REVEAL_CMD, title: 'Reveal in Graph', arguments: [n.ref.sha] };
    return item;
  }

  refresh(): void { this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }
}

export function createRemotesView(store: RefsStore, registry: Registry): vscode.Disposable {
  const provider = new RemotesView(store);
  const view = createRefTree('remotes', provider, store, registry);
  return vscode.Disposable.from(view, provider, store.onDidChange(() => provider.refresh()));
}
