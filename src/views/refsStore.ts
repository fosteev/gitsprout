import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import type { Refs, RepoSummary, Stash } from '../git/types';
import type { Registry } from '../workspace/registry';
import { repoViewDescription } from './refsModel';

/** Refs and stashes of the active repo, shared by the four ref trees; reloaded on every repo refresh. */
export class RefsStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  repo: RepoSummary | undefined;
  refs: Refs | undefined;
  stashes: Stash[] = [];
  private seq = 0;
  /** What the trees last rendered; an identical reload (focus refresh, unrelated watcher event) fires nothing. */
  private shown: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly registry: Registry, private readonly log: (m: string) => void) {
    this.repo = registry.active;
    this.disposables.push(
      this.emitter,
      registry.onDidChangeActive(() => void this.load()),
      registry.onDidChangeRepos(() => void this.load()),
      registry.onDidRefreshRepo((root) => { if (root === this.registry.active?.root) void this.load(); }),
    );
    void this.load();
  }

  /** A repo handle for the current repo (commands and diffs need its root and git path). */
  open(): Repo | undefined {
    return this.repo ? new Repo(this.repo.root, this.registry.gitPath) : undefined;
  }

  async load(): Promise<void> {
    const mine = ++this.seq;
    const repo = this.registry.active;
    if (!repo) {
      this.repo = undefined; this.refs = undefined; this.stashes = [];
      this.publish();
      return;
    }
    const r = new Repo(repo.root, this.registry.gitPath);
    try {
      const [refs, stashes] = await Promise.all([r.refs(), r.stashes()]);
      if (mine !== this.seq) return;
      this.repo = repo; this.refs = refs; this.stashes = stashes;
    } catch (e) {
      if (mine !== this.seq) return;
      this.log(`refs of ${repo.root}: ${e instanceof Error ? e.message : String(e)}`);
      this.repo = repo; this.refs = undefined; this.stashes = [];
    }
    this.publish();
  }

  private publish(): void {
    const sig = JSON.stringify([this.repo?.root, this.repo?.name, this.refs, this.stashes]);
    if (sig === this.shown) return;
    this.shown = sig;
    // Picks the trees' empty-state message (`viewsWelcome`): no repo / refs unreadable / genuinely empty.
    const state = !this.repo ? 'none' : this.refs ? 'ok' : 'error';
    void vscode.commands.executeCommand('setContext', 'gitsprout.refsState', state);
    this.emitter.fire();
  }

  dispose(): void { this.seq++; for (const d of this.disposables) d.dispose(); }
}

/** Creates a tree view whose description follows the active repo (multi-repo only). */
export function createRefTree<T>(
  id: string, provider: vscode.TreeDataProvider<T>, store: RefsStore, registry: Registry,
): vscode.TreeView<T> {
  const view = vscode.window.createTreeView(`gitsprout.${id}`, { treeDataProvider: provider });
  const update = () => { view.description = repoViewDescription(store.repo?.name, registry.repos.length > 1); };
  update();
  const sub = vscode.Disposable.from(store.onDidChange(update), registry.onDidChangeRepos(update));
  const dispose = view.dispose.bind(view);
  view.dispose = () => { sub.dispose(); dispose(); };
  return view;
}

/** Click on a ref row: reveal its commit in the graph. The graph (stage 5) listens to `onReveal`. */
const revealEmitter = new vscode.EventEmitter<string>();
export const onReveal = revealEmitter.event;
export const REVEAL_CMD = 'gitsprout._revealCommit';
export function registerReveal(): vscode.Disposable {
  return vscode.Disposable.from(revealEmitter, vscode.commands.registerCommand(REVEAL_CMD, (sha: string) => revealEmitter.fire(sha)));
}
