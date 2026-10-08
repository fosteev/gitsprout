import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { downloadedFonts, fontFaces, onDidChangeFonts } from '../fonts/store';
import { graphHtml } from '../graph/validate';
import { activeThemeName, onDidChangeThemeTokens, themeTokens } from '../theme/active';
import { categoriesFromManifest, parseFromSettings, SETTINGS_PREFIX, shownValue, validateValue } from './model';
import type { FromSettings, SettingSchema, SettingsCategory, SettingsScope, SettingsState, ToSettings } from './protocol';

export const SETTINGS_VIEW_TYPE = 'gitsprout.settings';
/** Ids implemented here; `registerStubCommands` skips them. */
export const SETTINGS_COMMAND_IDS = ['openSettings'] as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const hasWorkspace = (): boolean => (vscode.workspace.workspaceFolders?.length ?? 0) > 0;

/** The settings page: one editor tab over the native `gitsprout.*` configuration (nothing is stored anywhere else). */
class SettingsPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly categories: SettingsCategory[];
  private readonly byKey = new Map<string, SettingSchema>();
  private readonly storage: vscode.Uri;
  private scope: SettingsScope = 'user';
  private ready = false;
  private disposed = false;
  private seq = 0;
  readonly onDidDispose: vscode.Event<void>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: (m: string) => void) {
    const pkg = context.extension.packageJSON as { contributes?: { configuration?: unknown } };
    this.categories = categoriesFromManifest(pkg.contributes?.configuration);
    for (const c of this.categories) for (const s of c.settings) this.byKey.set(s.key, s);
    this.storage = context.globalStorageUri;
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(SETTINGS_VIEW_TYPE, 'Gitsprout Settings', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist, context.globalStorageUri],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'gear.svg');
    const wv = this.panel.webview;
    wv.html = graphHtml({
      title: 'Gitsprout Settings',
      cspSource: wv.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: wv.asWebviewUri(vscode.Uri.joinPath(dist, 'settings.js')).toString(),
      styleUri: wv.asWebviewUri(vscode.Uri.joinPath(dist, 'settings.css')).toString(),
    });
    this.onDidDispose = this.panel.onDidDispose;
    const push = (): void => void this.push();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      wv.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('gitsprout')) push(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(push),
      onDidChangeThemeTokens(push),
      onDidChangeFonts(push),
    );
  }

  reveal(): void { this.panel.reveal(this.panel.viewColumn); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  private async state(): Promise<SettingsState> {
    const c = vscode.workspace.getConfiguration('gitsprout');
    const workspace = hasWorkspace();
    if (this.scope === 'workspace' && !workspace) this.scope = 'user';
    const values: Record<string, unknown> = {};
    const modified: string[] = [];
    for (const s of this.byKey.values()) {
      const shown = shownValue(s.default, c.inspect(s.key), this.scope);
      values[s.key] = shown.value;
      if (shown.modified) modified.push(s.key);
    }
    const family = typeof values['diff.fontFamily'] === 'string' ? values['diff.fontFamily'] : '';
    const [fonts, faces] = await Promise.all([
      downloadedFonts(this.storage).catch(() => []),
      fontFaces(this.storage, family, this.panel.webview).catch(() => []),
    ]);
    return {
      categories: this.categories, scope: this.scope, hasWorkspace: workspace, values, modified,
      themeLabel: activeThemeName(), downloadedFonts: fonts.map((f) => f.family), tokens: themeTokens(), fontFaces: faces,
    };
  }

  private async push(): Promise<void> {
    if (!this.ready || this.disposed) return;
    const seq = ++this.seq;
    const state = await this.state();
    if (this.disposed || seq !== this.seq) return; // a newer push superseded this one
    const m: ToSettings = { type: 'state', state };
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const m = parseFromSettings(raw);
    if (!m) return;
    try {
      await this.handle(m);
    } catch (e) {
      this.log(`settings message ${m.type}: ${errText(e)}`);
      void vscode.window.showErrorMessage(`Gitsprout: ${errText(e)}`);
      void this.push(); // put the controls back to what is stored
    }
  }

  private target(scope: SettingsScope): vscode.ConfigurationTarget | undefined {
    if (scope === 'workspace' && !hasWorkspace()) return undefined;
    return scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  }

  private async handle(m: FromSettings): Promise<void> {
    const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('gitsprout');
    switch (m.type) {
      case 'ready': this.ready = true; await this.push(); return;
      case 'scope':
        this.scope = m.scope === 'workspace' && !hasWorkspace() ? 'user' : m.scope;
        await this.push();
        return;
      case 'set': {
        const schema = this.byKey.get(m.key);
        const target = this.target(m.scope);
        const checked = schema ? validateValue(schema, m.value) : undefined;
        if (!schema || target === undefined || !checked?.ok) {
          this.log(`settings: dropped ${SETTINGS_PREFIX}${m.key}: ${!schema ? 'unknown key' : target === undefined ? 'no workspace folder' : checked && !checked.ok ? checked.reason : 'invalid'}`);
          await this.push();
          return;
        }
        await cfg().update(m.key, checked.value, target);
        return;
      }
      case 'reset': {
        const target = this.target(m.scope);
        if (!this.byKey.has(m.key) || target === undefined) { await this.push(); return; }
        await cfg().update(m.key, undefined, target);
        return;
      }
      case 'openNative': {
        const { publisher, name } = this.context.extension.packageJSON as { publisher: string; name: string };
        await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${publisher}.${name}`);
        return;
      }
      case 'openJson':
        await vscode.commands.executeCommand(m.scope === 'workspace' && hasWorkspace() ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson');
        return;
      case 'downloadFont': await vscode.commands.executeCommand('gitsprout.downloadGoogleFont'); return;
      case 'removeFont': await vscode.commands.executeCommand('gitsprout.removeGoogleFont', m.family); return;
    }
  }
}

export function registerSettings(context: vscode.ExtensionContext, log: (m: string) => void): void {
  let open: SettingsPanel | undefined;
  context.subscriptions.push(
    { dispose: () => open?.dispose() },
    vscode.commands.registerCommand('gitsprout.openSettings', () => {
      if (open) { open.reveal(); return; }
      const p = new SettingsPanel(context, log);
      open = p;
      p.onDidDispose(() => { if (open === p) open = undefined; });
    }),
  );
}
