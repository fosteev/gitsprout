import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { GitError, type RepoSummary } from '../git/types';
import { mapPool } from '../util/pool';
import { discover, discoverWithParents, type DiscoveredRepo } from './discovery';
import { mainRootOf, makeRepoSummary, repoForPath, sameSummary, type FolderRef } from './model';

const SUMMARY_CONCURRENCY = 8;
const DEBOUNCE_MS = 300;
/** A steady stream of events (a dev server writing a log in the tree) still gets a refresh this often. */
const MAX_WAIT_MS = 2000;
/** `worktrees/**`: a commit, stage, lock or removal in a sibling worktree changes this repo's worktree list and statuses. */
const GIT_WATCH = '{HEAD,index,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**,worktrees/**}';
/** Refs of a linked worktree live in the shared (common) git dir. */
const COMMON_WATCH = '{packed-refs,refs/**,worktrees/**}';
/** workspaceState key: roots of worktrees outside the workspace folders that were opened on demand. */
export const EXTRA_ROOTS_KEY = 'gitsprout.extraRoots';

interface Entry {
  found: DiscoveredRepo;
  summary: RepoSummary;
  watchers: vscode.FileSystemWatcher[];
  timer?: NodeJS.Timeout;
  /** When the first event of the pending debounce window arrived (cleared when the refresh runs). */
  pendingSince?: number;
  /** The running `status` read; reads of one repo never overlap, so a stale result cannot overwrite a fresh one. */
  busy?: Promise<void>;
  /** One more read queued behind `busy`; later requests join it instead of spawning more processes. */
  queued?: Promise<void>;
}

/** `git.path` can be a string, a list of candidates or empty. */
export function configuredGitPath(): string {
  const p = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
  if (Array.isArray(p)) return p[0] || 'git';
  return p || 'git';
}

/** Repos of the workspace with their summaries, the active repo, watchers and change events. */
export class Registry implements vscode.Disposable {
  private entries = new Map<string, Entry>();
  private activeRoot: string | undefined;
  private scanning: Promise<void> = Promise.resolve();
  private scannedOnce = false;
  private gitMissingShown = false;
  private focusRefresh: Promise<void> | undefined;
  private focused = vscode.window.state.focused;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly reposEmitter = new vscode.EventEmitter<void>();
  private readonly activeEmitter = new vscode.EventEmitter<RepoSummary | undefined>();
  private readonly repoEmitter = new vscode.EventEmitter<string>();
  private readonly refreshedEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeRepos = this.reposEmitter.event;
  readonly onDidChangeActive = this.activeEmitter.event;
  readonly onDidChangeRepo = this.repoEmitter.event;
  /** Fires after every completed read of a repo, even when the summary is unchanged (a new tag/branch/stash does not change it). */
  readonly onDidRefreshRepo = this.refreshedEmitter.event;

  constructor(private readonly log: (msg: string) => void, private readonly state?: vscode.Memento) {
    this.disposables.push(
      this.reposEmitter, this.activeEmitter, this.repoEmitter, this.refreshedEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitsprout.scanDepth') || e.affectsConfiguration('gitsprout.scanExclude')) void this.rescan();
      }),
      // Also fires on `active` changes of a focused window: refresh only when focus is regained.
      vscode.window.onDidChangeWindowState((s) => {
        const regained = s.focused && !this.focused;
        this.focused = s.focused;
        if (regained) this.refreshOnFocus();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.follow(ed)),
    );
  }

  get repos(): RepoSummary[] {
    return [...this.entries.values()].map((e) => e.summary).sort((a, b) => a.relPath.localeCompare(b.relPath) || a.root.localeCompare(b.root));
  }
  get active(): RepoSummary | undefined { return this.activeRoot ? this.entries.get(this.activeRoot)?.summary : undefined; }
  get(root: string): RepoSummary | undefined { return this.entries.get(root)?.summary; }
  /** Depth of every repo below its workspace folder (for the built-in SCM depth check). */
  depths(): number[] { return [...this.entries.values()].map((e) => e.found.depth); }
  get gitPath(): string { return configuredGitPath(); }
  /** False until the first scan finishes (or fails): an empty registry before that means "still looking", not "no repos". */
  get scanned(): boolean { return this.scannedOnce; }

  private folders(): FolderRef[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  private extraRoots(): string[] {
    const v = this.state?.get<unknown>(EXTRA_ROOTS_KEY, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  /** Adds a repo outside the workspace folders (a worktree opened on demand); remembered across reloads. Rescans. */
  async addRoot(root: string): Promise<void> {
    const list = this.extraRoots();
    if (!list.includes(root)) await this.state?.update(EXTRA_ROOTS_KEY, [...list, root]);
    await this.rescan();
  }

  /** Forgets an extra root (a removed worktree). Rescans. */
  async removeRoot(root: string): Promise<void> {
    const list = this.extraRoots();
    if (list.includes(root)) await this.state?.update(EXTRA_ROOTS_KEY, list.filter((r) => r !== root));
    await this.rescan();
  }

  /** Scans the workspace folders; serialised, so overlapping triggers queue up. */
  rescan(): Promise<void> {
    this.scanning = this.scanning.then(() => this.doScan()).catch((e) => {
      this.log(`scan failed: ${String(e)}`);
      if (!this.scannedOnce) { this.scannedOnce = true; this.reposEmitter.fire(); }
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsprout');
    const folders = this.folders();
    if (this.disposed) return;
    const t0 = performance.now();
    const found = await discoverWithParents(folders.map((f) => f.path), cfg.get<number>('scanDepth', 3), cfg.get<string[]>('scanExclude', ['**/node_modules', '**/vendor']), this.gitPath);
    // Extra roots (depth 0, no climbing up): the ones that are gone drop out of the saved list.
    const extras = this.extraRoots();
    if (extras.length) {
      const have = await discover(extras, 0);
      for (const f of have) if (!found.some((x) => x.root === f.root)) found.push(f);
      const alive = extras.filter((r) => have.some((f) => f.root === r));
      if (alive.length !== extras.length) await this.state?.update(EXTRA_ROOTS_KEY, alive);
    }
    const next = new Map(found.map((f) => [f.root, f]));
    const t1 = performance.now();

    for (const [root, e] of [...this.entries]) {
      if (next.has(root)) continue;
      this.disposeEntry(e);
      this.entries.delete(root);
    }
    const added = found.filter((f) => !this.entries.has(f.root));
    await mapPool(added, SUMMARY_CONCURRENCY, async (f) => {
      const summary = await this.readSummary(f);
      if (!summary || this.disposed) return;
      this.entries.set(f.root, { found: f, summary, watchers: this.watch(f) });
    });
    if (this.disposed) return;
    // Existing repos may have moved relative to folders (multi-root changes the group prefix) — recompute.
    for (const e of this.entries.values()) {
      e.found = next.get(e.found.root) ?? e.found;
      const s = makeRepoSummary(e.found.root, folders, e.summary, mainRootOf(e.found.gitDir, e.found.commonDir));
      if (s.relPath !== e.summary.relPath || s.group !== e.summary.group || s.worktreeOf !== e.summary.worktreeOf) { e.summary = s; }
    }

    await vscode.commands.executeCommand('setContext', 'gitsprout.multiRepo', this.entries.size > 1);
    this.pickActive();
    const t2 = performance.now();
    this.log(`scan: ${this.entries.size} repositories in ${folders.length} folder(s); discovery ${Math.round(t1 - t0)} ms, summaries ${Math.round(t2 - t1)} ms (${added.length} read), total ${Math.round(t2 - t0)} ms`);
    this.scannedOnce = true;
    this.reposEmitter.fire();
  }

  private async readSummary(f: DiscoveredRepo): Promise<RepoSummary | undefined> {
    const root = f.root;
    try {
      return makeRepoSummary(root, this.folders(), await new Repo(root, this.gitPath).summary(), mainRootOf(f.gitDir, f.commonDir));
    } catch (e) {
      this.log(`summary failed for ${root}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof GitError && e.kind === 'GitMissing' && !this.gitMissingShown) {
        this.gitMissingShown = true;
        void vscode.window.showErrorMessage(`Gitsprout: ${e.message}. Set "git.path" or install git.`);
      }
      return undefined;
    }
  }

  private watch(f: DiscoveredRepo): vscode.FileSystemWatcher[] {
    const kick = () => this.schedule(f.root);
    const make = (dir: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
      w.onDidChange(kick); w.onDidCreate(kick); w.onDidDelete(kick);
      return w;
    };
    const ws = [make(f.gitDir, GIT_WATCH)];
    if (f.commonDir !== f.gitDir) ws.push(make(f.commonDir, COMMON_WATCH));
    return ws;
  }

  /** Debounced `refreshRepo` (DEBOUNCE_MS); every further call within the window restarts it, but never past MAX_WAIT_MS since the first one. */
  schedule(root: string): void {
    const e = this.entries.get(root);
    if (!e) return;
    const now = Date.now();
    e.pendingSince ??= now;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void this.refreshRepo(root), Math.max(0, Math.min(DEBOUNCE_MS, e.pendingSince + MAX_WAIT_MS - now)));
  }

  private disposeEntry(e: Entry): void {
    clearTimeout(e.timer);
    for (const w of e.watchers) w.dispose();
  }

  /**
   * Re-reads one repo; fires `onDidChangeRepo` only when the summary actually changed (`onDidRefreshRepo` after every read). Reads of one repo are
   * serialised: a request during a running read queues exactly one more read (which starts after the request,
   * so the caller sees state at least as new as its own change); further requests join that queued read.
   */
  refreshRepo(root: string): Promise<void> {
    const e = this.entries.get(root);
    if (!e) return Promise.resolve();
    clearTimeout(e.timer);
    e.timer = undefined;
    e.pendingSince = undefined;
    if (e.queued) return e.queued;
    if (e.busy) {
      e.queued = e.busy.then(() => { e.queued = undefined; return this.startRead(e, root); });
      return e.queued;
    }
    return this.startRead(e, root);
  }

  private startRead(e: Entry, root: string): Promise<void> {
    const p: Promise<void> = (async () => {
      const s = await this.readSummary(e.found);
      if (!s || this.disposed || this.entries.get(root) !== e) return;
      const changed = !sameSummary(e.summary, s);
      if (changed) e.summary = s;
      if (changed) this.repoEmitter.fire(root);
      this.refreshedEmitter.fire(root);
    })().finally(() => { if (e.busy === p) e.busy = undefined; });
    e.busy = p;
    return p;
  }

  async refreshAll(): Promise<void> {
    await mapPool([...this.entries.keys()], SUMMARY_CONCURRENCY, (r) => this.refreshRepo(r));
  }

  /** Focus refresh: at most one pass at a time; focus changes during a pass are ignored. */
  private refreshOnFocus(): void {
    if (this.focusRefresh) return;
    this.focusRefresh = this.refreshAll().finally(() => { this.focusRefresh = undefined; });
  }

  setActive(root: string | undefined): void {
    if (root === this.activeRoot) return;
    if (root !== undefined && !this.entries.has(root)) return;
    this.activeRoot = root;
    this.activeEmitter.fire(this.active);
  }

  /** Initial active repo: the one of the active editor, else the first. Keeps the current one while it exists. */
  private pickActive(): void {
    if (this.activeRoot && this.entries.has(this.activeRoot)) return;
    const roots = [...this.entries.keys()];
    const ed = vscode.window.activeTextEditor;
    const fromEditor = ed?.document.uri.scheme === 'file' ? repoForPath(roots, ed.document.uri.fsPath) : undefined;
    const first = this.repos[0]?.root;
    const next = fromEditor ?? first;
    if (next === this.activeRoot) return;
    this.activeRoot = next;
    this.activeEmitter.fire(this.active);
  }

  private follow(ed: vscode.TextEditor | undefined): void {
    if (!ed || ed.document.uri.scheme !== 'file') return;
    if (!vscode.workspace.getConfiguration('gitsprout').get<boolean>('followActiveEditor', true)) return;
    const root = repoForPath([...this.entries.keys()], ed.document.uri.fsPath);
    if (root) this.setActive(root);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    for (const d of this.disposables) d.dispose();
  }
}
