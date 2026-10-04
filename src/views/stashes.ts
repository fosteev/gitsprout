import * as vscode from 'vscode';
import type { Stash, StashFile } from '../git/types';
import type { Registry } from '../workspace/registry';
import { stashFileRow, stashLabel } from './refsModel';
import { createRefTree, type RefsStore } from './refsStore';

export interface StashNode { kind: 'stash'; stash: Stash }
export interface StashFileNode { kind: 'stashFile'; root: string; stash: Stash; file: StashFile }
type Node = StashNode | StashFileNode;

/** Internal command behind a click on a stash file (also the `stashFile` context entry). */
export const OPEN_STASH_FILE = 'gitsprout.openStashFile';

/** Stashes with their files (loaded on expand). Commands receive the `StashNode` / `StashFileNode`. */
export class StashesView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private files = new Map<string, Promise<StashFile[]>>();

  constructor(private readonly store: RefsStore) {}

  async getChildren(el?: Node): Promise<Node[]> {
    if (!el) return this.store.stashes.map((stash) => ({ kind: 'stash', stash }));
    if (el.kind !== 'stash') return [];
    const repo = this.store.open();
    const root = this.store.repo?.root;
    if (!repo || !root) return [];
    // Key by sha: indexes shift when a stash is dropped, the commit does not.
    const key = `${root}|${el.stash.sha}`;
    let p = this.files.get(key);
    const mine = !p;
    if (!p) { p = repo.stashFiles(el.stash.sha); this.files.set(key, p); }
    try {
      return (await p).map((file) => ({ kind: 'stashFile', root, stash: el.stash, file }));
    } catch (e) {
      // Concurrent callers share the promise; only the one that started the read reports the failure.
      if (!mine) return [];
      if (this.files.get(key) === p) this.files.delete(key);
      void vscode.window.showErrorMessage(`Gitsprout: can't read ${stashLabel(el.stash)}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const root = this.store.repo?.root ?? '';
    if (n.kind === 'stash') {
      const item = new vscode.TreeItem(stashLabel(n.stash), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${root}|stash:${n.stash.sha}`;
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = n.stash.message;
      item.tooltip = n.stash.message;
      item.contextValue = 'stash';
      return item;
    }
    const row = stashFileRow(n.file);
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${root}|stashfile:${n.stash.sha}:${n.file.path}`;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(row.color));
    item.contextValue = 'stashFile';
    item.command = { command: OPEN_STASH_FILE, title: 'Open Changes', arguments: [n] };
    return item;
  }

  refresh(): void { this.files.clear(); this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }
}

export function createStashesView(store: RefsStore, registry: Registry): vscode.Disposable {
  const provider = new StashesView(store);
  const view = createRefTree('stashes', provider, store, registry);
  return vscode.Disposable.from(view, provider, store.onDidChange(() => provider.refresh()));
}
