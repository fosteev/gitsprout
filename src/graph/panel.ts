import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { openPlan } from '../diff/provider';
import { commitFilePlan, stagedPlan, unstagedPlan } from '../diff/uri';
import { Repo } from '../git/repo';
import type { Commit, Head, Status } from '../git/types';
import { onReveal } from '../views/refsStore';
import type { Registry } from '../workspace/registry';
import type { FromWebview, GraphSettings, ToWebview } from './protocol';
import { graphHtml, isAllowedUrl, parseFromWebview, shaFromArg, stateMessage } from './validate';

export const VIEW_TYPE = 'gitsprout.graph';
/** Ids implemented here; `registerStubCommands` skips them. */
export const GRAPH_COMMAND_IDS = ['showGraph', 'toggleAutoBuild', 'copySha', 'copyMessage'] as const;

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

/** Writes where the user's value currently lives (workspace if set there, else user settings). */
async function setSetting(key: string, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration('gitsprout');
  const target = c.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

/** The single graph tab: follows the active repo, re-sends `state` when the repo refreshes. */
class GraphPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private seq = 0;
  /** A refresh arrived while the tab was hidden: reload when it becomes visible. */
  private dirty = false;
  private lastState: string | undefined;
  private root: string | undefined;
  private commits = new Map<string, Commit>();
  private head: Head = { branch: null, sha: null };
  private wip: Status | null = null;
  readonly onDidDispose: vscode.Event<void>;

  /** `revived`: the panel VS Code recreated after a window reload (see `registerGraph`); else a new tab is opened. */
  constructor(context: vscode.ExtensionContext, private readonly registry: Registry, private readonly log: (m: string) => void, revived?: vscode.WebviewPanel) {
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const options = { enableScripts: true, localResourceRoots: [dist] };
    if (revived) {
      this.panel = revived;
      // VS Code restores the creation options (incl. `retainContextWhenHidden`) with the tab; re-applied to be explicit.
      revived.webview.options = options;
    } else {
      this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Graph', vscode.ViewColumn.Active, { ...options, retainContextWhenHidden: true });
    }
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
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState(() => { if (this.panel.visible && this.dirty) reload(); }),
      wv.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      this.registry.onDidChangeActive(reload),
      this.registry.onDidChangeRepos(reload),
      this.registry.onDidRefreshRepo((root) => { if (root === this.registry.active?.root) reload(); }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (['ciPattern', 'hideCi', 'jira', 'logLimit'].some((k) => e.affectsConfiguration(`gitsprout.${k}`))) reload();
      }),
    );
  }

  reveal(): void { this.panel.reveal(this.panel.viewColumn, false); }

  /** A tree row was clicked: select the commit in the graph without taking focus. */
  revealCommit(sha: string): void {
    if (!this.ready) return;
    this.panel.reveal(this.panel.viewColumn, true);
    this.post({ type: 'reveal', sha });
  }

  commit(sha: string): Commit | undefined { return this.commits.get(sha); }

  /** No-op once disposed: a `select`/`load` that finishes after the tab closed must not touch the dead webview. */
  private post(m: ToWebview): void { if (!this.disposed) void this.panel.webview.postMessage(m); }

  private async load(): Promise<void> {
    if (!this.ready) return;
    if (!this.panel.visible) { this.dirty = true; return; }
    this.dirty = false;
    const mine = ++this.seq;
    const active = this.registry.active;
    if (!active && !this.registry.scanned) {
      // A tab restored after a reload, before the first scan: show "Loading…"; `onDidChangeRepos` reloads it.
      this.post({ type: 'busy', on: true });
      return;
    }
    if (!active) {
      this.root = undefined; this.commits.clear(); this.lastState = undefined;
      this.panel.title = 'Graph';
      this.post({ type: 'busy', on: false }); // a superseded load won't clear it
      this.post({ type: 'error', message: 'No Git repository in the workspace.' });
      return;
    }
    this.post({ type: 'busy', on: true });
    const settings = readSettings();
    const t0 = performance.now();
    try {
      const repo = new Repo(active.root, this.registry.gitPath);
      const [commits, refs, status] = await Promise.all([repo.log(settings.logLimit), repo.refs(), repo.status()]);
      if (mine !== this.seq) return;
      const wip = status.staged.length + status.unstaged.length > 0 ? status : null;
      this.root = active.root;
      this.commits = new Map(commits.map((c) => [c.sha, c]));
      this.head = refs.head;
      this.wip = wip;
      this.panel.title = `Graph · ${active.name}`;
      const msg = stateMessage({ root: active.root, name: active.name }, this.registry.repos.length, refs, commits, wip, settings);
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
      case 'openScm': await vscode.commands.executeCommand('workbench.view.scm'); return;
      case 'switchRepo': await vscode.commands.executeCommand('gitsprout.switchRepository'); return;
      case 'refresh': {
        const root = this.registry.active?.root;
        if (root) await this.registry.refreshRepo(root);
        return;
      }
      case 'toggleCi': await setSetting('hideCi', m.hideCi); return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Gitsprout: copied', 2000);
        return;
      case 'openUrl':
        if (isAllowedUrl(m.url, readSettings().jira)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
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

/** `showGraph`, `toggleAutoBuild`, the graph's context-menu copy commands and tree → graph reveal. */
export function registerGraph(context: vscode.ExtensionContext, registry: Registry, log: (m: string) => void): void {
  let panel: GraphPanel | undefined;

  const adopt = (p: GraphPanel): void => {
    panel = p;
    p.onDidDispose(() => { if (panel === p) panel = undefined; });
  };

  const show = (): void => {
    if (panel) { panel.reveal(); return; }
    if (!registry.active) {
      void vscode.window.showInformationMessage('Gitsprout: no Git repository in the workspace.');
      return;
    }
    adopt(new GraphPanel(context, registry, log));
  };

  const sha = (arg: unknown): string | undefined => {
    const s = shaFromArg(arg);
    if (!s) void vscode.window.showInformationMessage('Gitsprout: pick a commit in the graph (right-click a row).');
    return s;
  };

  context.subscriptions.push(
    { dispose: () => panel?.dispose() },
    // Window reload: VS Code restores the tab and hands it back; the graph re-attaches and loads the active repo
    // (during the first scan it shows "Loading…" and reloads on `onDidChangeRepos`).
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (revived) => {
        if (panel) { revived.dispose(); return Promise.resolve(); } // one graph tab only
        adopt(new GraphPanel(context, registry, log, revived));
        return Promise.resolve();
      },
    }),
    vscode.commands.registerCommand('gitsprout.showGraph', show),
    vscode.commands.registerCommand('gitsprout.toggleAutoBuild', () => setSetting('hideCi', !readSettings().hideCi)),
    vscode.commands.registerCommand('gitsprout.copySha', async (arg?: unknown) => {
      const s = sha(arg);
      if (!s) return;
      await vscode.env.clipboard.writeText(panel?.commit(s)?.sha ?? s);
      vscode.window.setStatusBarMessage('Gitsprout: commit SHA copied', 2000);
    }),
    vscode.commands.registerCommand('gitsprout.copyMessage', async (arg?: unknown) => {
      const s = sha(arg);
      const c = s ? panel?.commit(s) : undefined;
      if (!c) return;
      await vscode.env.clipboard.writeText(c.body.trim() ? `${c.subject}\n\n${c.body.trim()}` : c.subject);
      vscode.window.setStatusBarMessage('Gitsprout: commit message copied', 2000);
    }),
    onReveal((s) => panel?.revealCommit(s)),
  );
}
