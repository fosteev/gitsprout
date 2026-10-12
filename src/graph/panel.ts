import { randomBytes } from 'node:crypto';
import { basename, relative } from 'node:path';
import * as vscode from 'vscode';
import { openPlan } from '../diff/provider';
import { commitFilePlan, stagedPlan, unstagedPlan } from '../diff/uri';
import type { WipActions } from '../commands/wip';
import { Repo } from '../git/repo';
import type { Commit, FilePatch, Head, Status } from '../git/types';
import { onReveal } from '../views/refsStore';
import { repoDisplayName } from '../workspace/model';
import { fontFaces, onDidChangeFonts } from '../fonts/store';
import { onDidChangeThemeTokens, themeTokens } from '../theme/active';
import type { Registry } from '../workspace/registry';
import type { DiffStyle, FontFaceSrc, FromWebview, GraphSettings, GraphWorktree, ToolbarAction, ToWebview } from './protocol';
import { graphWorktrees, needSummary } from './worktrees';
import { graphHtml, inGitDir, isAllowedUrl, parseFromWebview, shaFromArg, stateMessage, wipContextFromArg } from './validate';

export const VIEW_TYPE = 'gitsprout.graph';
/** Ids implemented here; `registerStubCommands` skips them. */
export const GRAPH_COMMAND_IDS = ['showGraph', 'toggleAutoBuild', 'copySha', 'copyMessage', 'wipStage', 'wipUnstage', 'wipDiscard'] as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function readSettings(): GraphSettings {
  const c = vscode.workspace.getConfiguration('gitsprout');
  return {
    ciPattern: c.get<string>('ciPattern', '^AutoBuild$'),
    hideCi: c.get<boolean>('hideCi', false),
    jira: c.get<Record<string, string>>('jira', {}),
    logLimit: Math.max(1, c.get<number>('logLimit', 1000)),
  };
}

const HIGHLIGHT_THEMES: readonly string[] = ['auto', 'simple', 'github', 'one'];

/** `gitsprout.diff.*`, normalised. `faces`: webview URIs of the downloaded Google font named by `fontFamily` (see `fontFaces`). */
export function diffStyle(faces: FontFaceSrc[] = []): DiffStyle {
  const c = vscode.workspace.getConfiguration('gitsprout');
  const raw = c.get<string>('diff.highlightTheme', 'auto');
  const theme = (HIGHLIGHT_THEMES.includes(raw) ? raw : 'auto') as DiffStyle['theme'];
  const size = c.get<number>('diff.fontSize', 0);
  return {
    highlight: c.get<boolean>('diff.syntaxHighlighting', true),
    theme,
    tokens: theme === 'auto' ? themeTokens() : null,
    fontFamily: c.get<string>('diff.fontFamily', '').trim(),
    fontSize: Number.isFinite(size) ? Math.min(40, Math.max(0, size)) : 0,
    fontFaces: faces,
  };
}

/** Writes where the user's value currently lives (workspace if set there, else user settings). */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration('gitsprout');
  const target = c.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

/** One graph tab per repo: bound to `repoRoot`, re-sends `state` when that repo refreshes; focusing it makes the repo active. */
class GraphPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private seq = 0;
  private styleSeq = 0;
  private readonly storage: vscode.Uri;
  /** A refresh arrived while the tab was hidden: reload when it becomes visible. */
  private dirty = false;
  private lastState: string | undefined;
  /** The repo whose history is loaded; undefined while the tab shows an error. */
  private root: string | undefined;
  private commits = new Map<string, Commit>();
  private head: Head = { branch: null, sha: null };
  private wip: Status | null = null;
  /** The worktrees of the last `state`: a `worktree` message may only name one of these. */
  private worktrees: GraphWorktree[] = [];
  readonly onDidDispose: vscode.Event<void>;

  /** `revived`: the panel VS Code recreated after a window reload (see `registerGraph`); else a new tab is opened. */
  constructor(
    context: vscode.ExtensionContext,
    private readonly registry: Registry,
    private readonly log: (m: string) => void,
    private readonly wipActions: WipActions,
    readonly repoRoot: string,
    revived?: vscode.WebviewPanel,
  ) {
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.storage = context.globalStorageUri;
    const options = { enableScripts: true, localResourceRoots: [dist, context.globalStorageUri] };
    if (revived) {
      this.panel = revived;
      // VS Code restores the creation options (incl. `retainContextWhenHidden`) with the tab; re-applied to be explicit.
      revived.webview.options = options;
    } else {
      this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Graph', vscode.ViewColumn.Active, { ...options, retainContextWhenHidden: true });
    }
    const known = registry.get(repoRoot);
    this.panel.title = `Graph · ${known ? repoDisplayName(known.name, known.worktreeOf) : basename(repoRoot)}`;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'sprout.svg');
    const wv = this.panel.webview;
    wv.html = graphHtml({
      cspSource: wv.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: wv.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: wv.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
    });
    this.onDidDispose = this.panel.onDidDispose;
    const reload = () => void this.load();
    // Working-tree edits don't touch the git dir the registry watches, so a staging panel watches the tree itself
    // (one watcher per open tab; `files.watcherExclude` applies). Anything under a `.git` folder is the registry's job.
    const tree = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repoRoot), '**'));
    // Checked relative to the root, so a root that itself lies under some `.git` folder still gets its events.
    const kick = (uri: vscode.Uri): void => { if (!inGitDir(relative(repoRoot, uri.fsPath))) this.registry.schedule(this.repoRoot); };
    this.disposables.push(
      tree, tree.onDidChange(kick), tree.onDidCreate(kick), tree.onDidDelete(kick),
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState(() => {
        if (this.panel.active) this.registry.setActive(this.repoRoot);
        if (this.panel.visible && this.dirty) reload();
      }),
      wv.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      this.registry.onDidChangeRepos(reload),
      this.registry.onDidRefreshRepo((root) => { if (root === this.repoRoot) reload(); }),
      onDidChangeThemeTokens(() => this.postDiffStyle()),
      onDidChangeFonts(() => this.postDiffStyle()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (['ciPattern', 'hideCi', 'jira', 'logLimit'].some((k) => e.affectsConfiguration(`gitsprout.${k}`))) reload();
        if (e.affectsConfiguration('gitsprout.diff')) this.postDiffStyle();
      }),
    );
  }

  reveal(preserveFocus: boolean): void { this.panel.reveal(this.panel.viewColumn, preserveFocus); }

  /** A tree row was clicked: select the commit in the graph without taking focus. */
  revealCommit(sha: string): void {
    if (!this.ready) return;
    this.panel.reveal(this.panel.viewColumn, true);
    this.post({ type: 'reveal', sha });
  }

  private postDiffStyle(): void {
    if (!this.ready) return;
    const seq = ++this.styleSeq;
    const family = vscode.workspace.getConfiguration('gitsprout').get<string>('diff.fontFamily', '').trim();
    void fontFaces(this.storage, family, this.panel.webview).catch(() => [] as FontFaceSrc[]).then((faces) => {
      // a newer change superseded this one while the manifest was being read
      if (!this.disposed && seq === this.styleSeq) this.post({ type: 'diffStyle', style: diffStyle(faces) });
    });
  }

  commit(sha: string): Commit | undefined { return this.commits.get(sha); }

  /** No-op once disposed: a `select`/`load` that finishes after the tab closed must not touch the dead webview. */
  private post(m: ToWebview): void { if (!this.disposed) void this.panel.webview.postMessage(m); }

  private async load(): Promise<void> {
    if (!this.ready) return;
    if (!this.panel.visible) { this.dirty = true; return; }
    this.dirty = false;
    const mine = ++this.seq;
    const active = this.registry.get(this.repoRoot);
    if (!active && !this.registry.scanned) {
      // A tab restored after a reload, before the first scan: show "Loading…"; `onDidChangeRepos` reloads it.
      this.post({ type: 'busy', on: true });
      return;
    }
    if (!active) {
      this.root = undefined; this.commits.clear(); this.lastState = undefined;
      this.post({ type: 'busy', on: false }); // a superseded load won't clear it
      this.post({ type: 'error', message: `${basename(this.repoRoot)} is no longer a Git repository in the workspace.` });
      return;
    }
    this.post({ type: 'busy', on: true });
    const settings = readSettings();
    const t0 = performance.now();
    try {
      const repo = new Repo(active.root, this.registry.gitPath);
      const [commits, refs, status, stashes, wts] = await Promise.all([
        repo.log(settings.logLimit), repo.refs(), repo.status(), repo.stashes(),
        // The graph must not fail because the worktree list could not be read.
        repo.worktrees().catch((e: unknown) => { this.log(`graph worktrees ${active.root}: ${errText(e)}`); return []; }),
      ]);
      const worktrees = await this.worktreeList(wts, active.root);
      if (mine !== this.seq) return;
      const wip = status.staged.length + status.unstaged.length > 0 ? status : null;
      this.root = active.root;
      this.commits = new Map(commits.map((c) => [c.sha, c]));
      this.head = refs.head;
      this.wip = wip;
      this.worktrees = worktrees;
      this.panel.title = `Graph · ${repoDisplayName(active.name, active.worktreeOf)}`;
      const msg = stateMessage({ root: active.root, name: active.name }, this.registry.repos.length, refs, commits, wip, settings, stashes.length, worktrees);
      const sig = JSON.stringify(msg);
      if (sig !== this.lastState) { this.lastState = sig; this.post(msg); }
      this.log(`graph state ${active.name}: ${Math.round(performance.now() - t0)} ms (${commits.length} commits)`);
    } catch (e) {
      if (mine !== this.seq) return;
      this.log(`graph ${active.root}: ${errText(e)}`);
      this.root = undefined; this.commits.clear(); this.lastState = undefined;
      this.post({ type: 'error', message: `Can't read the history of ${active.name}: ${errText(e)}` });
    } finally {
      if (mine === this.seq) this.post({ type: 'busy', on: false });
    }
  }

  /** Other worktrees' uncommitted-file counts: the registry's summary first, then at most `MAX_WORKTREE_SUMMARIES` status reads. */
  private async worktreeList(list: Parameters<typeof graphWorktrees>[0], root: string): Promise<GraphWorktree[]> {
    const counts = new Map<string, number>();
    for (const w of list) {
      const known = this.registry.get(w.path);
      if (known) counts.set(w.path, known.changes);
    }
    const base = graphWorktrees(list, root, counts);
    const reads = needSummary(base, (p) => counts.has(p));
    await Promise.all(reads.map(async (p) => {
      try { counts.set(p, (await new Repo(p, this.registry.gitPath).summary()).changes); } catch { /* unknown = 0 */ }
    }));
    return reads.length ? graphWorktrees(list, root, counts) : base;
  }

  private async onMessage(raw: unknown): Promise<void> {
    const m = parseFromWebview(raw);
    if (!m) return;
    try {
      await this.handle(m);
    } catch (e) {
      this.log(`graph message ${m.type}: ${errText(e)}`);
      void vscode.window.showErrorMessage(`Gitsprout: ${errText(e)}`);
    }
  }

  private async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.lastState = undefined;
        await this.load();
        this.postDiffStyle();
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('gitsprout.openSettings');
        return;
      case 'select': {
        const root = this.root;
        if (!root || !this.commits.has(m.sha)) return;
        try {
          const files = await new Repo(root, this.registry.gitPath).commitFiles(m.sha);
          if (root === this.root) this.post({ type: 'details', sha: m.sha, files });
        } catch (e) {
          this.log(`graph files ${m.sha}: ${errText(e)}`);
          if (root === this.root) this.post({ type: 'details', sha: m.sha, files: [], error: errText(e) });
        }
        return;
      }
      case 'openCommitFile': {
        const c = this.commits.get(m.sha);
        if (!this.root || !c) return;
        await this.open(commitFilePlan(m.sha, m.file, c.parents[0]));
        return;
      }
      case 'openWipFile': {
        if (!this.root || !this.wip) return;
        const list = m.area === 'staged' ? this.wip.staged : this.wip.unstaged;
        // Use our own copy of the entry: only files that really are in the working tree list may be opened.
        const f = list.find((x) => x.path === m.file.path && x.origPath === m.file.origPath);
        if (!f) return;
        await this.open(m.area === 'staged' ? stagedPlan(f, this.head.sha === null) : unstagedPlan(f));
        return;
      }
      case 'openWorkingFile': {
        if (!this.root) return;
        const uri = vscode.Uri.joinPath(vscode.Uri.file(this.root), m.path);
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          void vscode.window.showWarningMessage(`Gitsprout: ${m.path} is not in the working tree.`);
          return;
        }
        const at = m.line ? new vscode.Position(m.line - 1, 0) : undefined;
        await vscode.commands.executeCommand('vscode.open', uri, at && { selection: new vscode.Range(at, at) });
        return;
      }
      case 'diffCommitFile': {
        const c = this.commits.get(m.sha);
        if (!this.root || !c) return;
        const { file } = m;
        await this.sendDiff(m.req, (repo) => repo.patch({ kind: 'commit', sha: m.sha, parent: c.parents[0] ?? null, path: file.path, origPath: file.origPath }));
        return;
      }
      case 'diffWipFile': {
        if (!this.root || !this.wip) return;
        const list = m.area === 'staged' ? this.wip.staged : this.wip.unstaged;
        const f = list.find((x) => x.path === m.file.path && x.origPath === m.file.origPath);
        if (!f) return;
        await this.sendDiff(m.req, (repo) => repo.patch(
          m.area === 'staged' ? { kind: 'staged', path: f.path, origPath: f.origPath }
            : f.untracked ? { kind: 'untracked', path: f.path }
            : { kind: 'unstaged', path: f.path },
        ));
        return;
      }
      case 'stage': await this.withWipBusy(() => this.wipActions.stage(this.repoRoot, m.files)); return;
      case 'unstage': await this.withWipBusy(() => this.wipActions.unstage(this.repoRoot, m.files)); return;
      case 'stageAll': await this.withWipBusy(() => this.wipActions.stageAll(this.repoRoot)); return;
      case 'unstageAll': await this.withWipBusy(() => this.wipActions.unstageAll(this.repoRoot)); return;
      case 'discard': await this.withWipBusy(() => this.wipActions.discard(this.repoRoot, m.file)); return;
      case 'discardAll': await this.withWipBusy(() => this.wipActions.discardAll(this.repoRoot)); return;
      case 'commit': {
        const sha = await this.withWipBusy(() => this.wipActions.commit(this.repoRoot, m));
        if (sha) this.post({ type: 'committed', sha });
        return;
      }
      case 'amendInfo': {
        const info = await this.wipActions.amendInfo(this.repoRoot);
        if (info) this.post(info);
        return;
      }
      case 'openScm': await vscode.commands.executeCommand('workbench.view.scm'); return;
      case 'switchRepo':
        // The picked repo becomes active; open (or bring up) its own tab. A cancelled pick leaves this tab's repo active.
        await vscode.commands.executeCommand('gitsprout.switchRepository');
        await vscode.commands.executeCommand('gitsprout.showGraph');
        return;
      case 'refresh': await this.registry.refreshRepo(this.repoRoot); return;
      case 'toggleCi': await setSetting('hideCi', m.hideCi); return;
      case 'action': await this.runAction(m.action); return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Gitsprout: copied', 2000);
        return;
      case 'checkout':
        // The commands re-read the refs: a branch gone since the last state fails like any other checkout.
        await vscode.commands.executeCommand(m.kind === 'local' ? 'gitsprout.checkoutBranch' : 'gitsprout.checkoutRemote',
          { root: this.repoRoot, branchKind: m.kind, branchName: m.name });
        return;
      case 'worktree': {
        // Only worktrees the last state listed; the existing commands re-check everything else (missing folder, not a repo).
        const w = this.worktrees.find((x) => x.path === m.path);
        if (!w) return;
        const id = m.action === 'openGraph' ? 'worktreeOpenGraph' : m.action === 'openWindow' ? 'worktreeOpenWindow' : 'worktreeTerminal';
        await vscode.commands.executeCommand(`gitsprout.${id}`, w.path);
        return;
      }
      case 'openUrl':
        if (isAllowedUrl(m.url, readSettings().jira)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
    }
  }

  /** A toolbar button: the same commands as the palette, pinned to this tab's repo (not whichever repo is active). */
  private async runAction(action: ToolbarAction): Promise<void> {
    const root = this.repoRoot;
    switch (action) {
      case 'fetch': await vscode.commands.executeCommand('gitsprout.repoFetch', { root }); return;
      case 'pull': await vscode.commands.executeCommand('gitsprout.pull', root); return;
      case 'push': await vscode.commands.executeCommand('gitsprout.push', root); return;
      case 'branch': await vscode.commands.executeCommand('gitsprout.createBranch', root); return;
      case 'stash': await vscode.commands.executeCommand('gitsprout.stash', root); return;
      case 'pop': await vscode.commands.executeCommand('gitsprout.stashPop', root); return;
      case 'terminal':
        vscode.window.createTerminal({ name: this.registry.get(root)?.name ?? basename(root), cwd: root }).show();
        return;
    }
  }

  /** Runs the patch read and posts the `diff` answer unless the panel switched repos meanwhile. */
  private async sendDiff(req: number, read: (repo: Repo) => Promise<FilePatch>): Promise<void> {
    const root = this.root;
    if (!root) return;
    let msg: ToWebview;
    try {
      msg = { type: 'diff', req, patch: await read(new Repo(root, this.registry.gitPath)) };
    } catch (e) {
      this.log(`graph diff: ${errText(e)}`);
      msg = { type: 'diff', req, error: errText(e) };
    }
    if (root === this.root) this.post(msg);
  }

  private wipRunning = 0;

  /** Runs one WIP op with `wipBusy` on around it (a counter: the webview already disables its buttons, this is the backstop for racing messages). */
  async withWipBusy<T>(op: () => Promise<T>): Promise<T> {
    if (this.wipRunning++ === 0) this.post({ type: 'wipBusy', on: true });
    try {
      return await op();
    } finally {
      if (--this.wipRunning === 0) this.post({ type: 'wipBusy', on: false });
    }
  }

  private async open(plan: Parameters<typeof openPlan>[1]): Promise<void> {
    if (!this.root) return;
    try {
      await openPlan(this.root, plan);
    } catch (e) {
      void vscode.window.showErrorMessage(`Gitsprout: can't open the diff: ${errText(e)}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.seq++;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

/** What other command modules need from the graph tabs. */
export interface GraphApi {
  /** Closes the repo's tab if it is open (a removed worktree). */
  close: (root: string) => void;
}

/** `showGraph`, `toggleAutoBuild`, the graph's context-menu copy commands and tree → graph reveal. */
export function registerGraph(context: vscode.ExtensionContext, registry: Registry, log: (m: string) => void, wip: WipActions): GraphApi {
  /** Open graph tabs by repo root: at most one per repo. */
  const panels = new Map<string, GraphPanel>();

  const adopt = (p: GraphPanel): void => {
    panels.set(p.repoRoot, p);
    p.onDidDispose(() => { if (panels.get(p.repoRoot) === p) panels.delete(p.repoRoot); });
  };

  /** Brings up the repo's tab, opening it the first time; `root` defaults to the active repo. */
  const show = (root?: string, preserveFocus = false): void => {
    root ??= registry.active?.root;
    if (!root) {
      void vscode.window.showInformationMessage('Gitsprout: no Git repository in the workspace.');
      return;
    }
    const open = panels.get(root);
    if (open) { open.reveal(preserveFocus); return; }
    adopt(new GraphPanel(context, registry, log, wip, root));
  };

  /** The commit as loaded by any open tab (context-menu commands carry only the SHA). */
  const commit = (s: string): Commit | undefined => {
    for (const p of panels.values()) {
      const c = p.commit(s);
      if (c) return c;
    }
    return undefined;
  };

  const sha = (arg: unknown): string | undefined => {
    const s = shaFromArg(arg);
    if (!s) void vscode.window.showInformationMessage('Gitsprout: pick a commit in the graph (right-click a row).');
    return s;
  };

  context.subscriptions.push(
    { dispose: () => { for (const p of [...panels.values()]) p.dispose(); } },
    // Window reload: VS Code restores the tabs and hands them back with the webview state (`{ root }`, set by the
    // webview on every `state`); each re-attaches to its repo (during the first scan it shows "Loading…").
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (revived, state: unknown) => {
        const root = (state as { root?: unknown } | undefined)?.root;
        if (typeof root !== 'string' || panels.has(root)) { revived.dispose(); return Promise.resolve(); }
        adopt(new GraphPanel(context, registry, log, wip, root, revived));
        return Promise.resolve();
      },
    }),
    vscode.commands.registerCommand('gitsprout.showGraph', (root?: unknown, preserveFocus?: unknown) =>
      show(typeof root === 'string' ? root : undefined, preserveFocus === true)),
    vscode.commands.registerCommand('gitsprout.toggleAutoBuild', () => setSetting('hideCi', !readSettings().hideCi)),
    vscode.commands.registerCommand('gitsprout.copySha', async (arg?: unknown) => {
      const s = sha(arg);
      if (!s) return;
      await vscode.env.clipboard.writeText(commit(s)?.sha ?? s);
      vscode.window.setStatusBarMessage('Gitsprout: commit SHA copied', 2000);
    }),
    vscode.commands.registerCommand('gitsprout.copyMessage', async (arg?: unknown) => {
      const s = sha(arg);
      const c = s ? commit(s) : undefined;
      if (!c) return;
      await vscode.env.clipboard.writeText(c.body.trim() ? `${c.subject}\n\n${c.body.trim()}` : c.subject);
      vscode.window.setStatusBarMessage('Gitsprout: commit message copied', 2000);
    }),
    // WIP row context menus: through the row's tab so its buttons are disabled while the op runs.
    ...(['wipStage', 'wipUnstage', 'wipDiscard'] as const).map((id) => vscode.commands.registerCommand(`gitsprout.${id}`, async (arg?: unknown) => {
      const c = wipContextFromArg(arg);
      if (!c) return;
      const op = id === 'wipStage' ? () => wip.stagePath(c.root, c.path)
        : id === 'wipUnstage' ? () => wip.unstagePath(c.root, c.path)
        : () => wip.discard(c.root, { path: c.path, origPath: c.origPath });
      const p = panels.get(c.root);
      await (p ? p.withWipBusy(op) : op());
    })),
    // The ref trees show the active repo, so a tree click goes to that repo's tab (if open).
    onReveal((s) => { const root = registry.active?.root; if (root) panels.get(root)?.revealCommit(s); }),
  );
  return { close: (root) => panels.get(root)?.dispose() };
}
