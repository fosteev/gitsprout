import * as vscode from 'vscode';
import { registerStubCommands } from './commands/stubs';
import { REPO_COMMAND_IDS, registerRepoCommands } from './commands/repos';
import { VIEW_IDS } from './commands/ids';
import { EmptyTreeProvider } from './views/emptyTree';
import { RepositoriesView } from './views/repositories';
import { createStatusBar } from './views/statusBar';
import { Registry } from './workspace/registry';
import { createScmDepthCheck } from './workspace/scmDepth';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Gitsprout');
  const log = (m: string) => out.appendLine(`${new Date().toISOString()} ${m}`);
  context.subscriptions.push(out);

  void vscode.commands.executeCommand('setContext', 'gitsprout.multiRepo', false);
  // Stage 4 replaces the remaining empty trees; Repositories is real.
  for (const id of VIEW_IDS) {
    if (id === 'repositories') continue;
    context.subscriptions.push(vscode.window.registerTreeDataProvider(`gitsprout.${id}`, new EmptyTreeProvider()));
  }

  const registry = new Registry(log);
  const view = new RepositoriesView(registry, context.workspaceState);
  context.subscriptions.push(registry, view, createStatusBar(registry));
  registerRepoCommands(context, registry, view, log);
  registerStubCommands(context, REPO_COMMAND_IDS);

  const checkScmDepth = createScmDepthCheck(registry, context.workspaceState, log);
  void registry.rescan().then(() => checkScmDepth());
}

export function deactivate(): void {}
