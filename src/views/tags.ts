import * as vscode from 'vscode';
import type { Tag } from '../git/types';
import type { Registry } from '../workspace/registry';
import { short, sortTags } from './refsModel';
import { createRefTree, REVEAL_CMD, type RefsStore } from './refsStore';

/** Tags, newest-looking first. Commands receive the `Tag`. */
export class TagsView implements vscode.TreeDataProvider<Tag> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: RefsStore) {}

  getChildren(el?: Tag): Tag[] {
    return el || !this.store.refs ? [] : sortTags(this.store.refs.tags);
  }

  getTreeItem(t: Tag): vscode.TreeItem {
    const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
    item.id = `${this.store.repo?.root ?? ''}|tag:${t.name}`;
    item.iconPath = new vscode.ThemeIcon('tag');
    item.description = short(t.sha);
    item.contextValue = 'tag';
    item.tooltip = `${t.name} · ${short(t.sha)}`;
    item.command = { command: REVEAL_CMD, title: 'Reveal in Graph', arguments: [t.sha] };
    return item;
  }

  refresh(): void { this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }
}

export function createTagsView(store: RefsStore, registry: Registry): vscode.Disposable {
  const provider = new TagsView(store);
  const view = createRefTree('tags', provider, store, registry);
  return vscode.Disposable.from(view, provider, store.onDidChange(() => provider.refresh()));
}
