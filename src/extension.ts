import * as vscode from 'vscode';
import { COMMIT_COMMAND_IDS, registerCommitCommands } from './commands/commits';
import { registerStubCommands } from './commands/stubs';
import { MUTATION_COMMAND_IDS, registerMutations } from './commands/mutations';
import { REF_COMMAND_IDS, registerRefViews } from './commands/refs';
import { REPO_COMMAND_IDS, registerRepoCommands } from './commands/repos';
import { GRAPH_COMMAND_IDS, registerGraph } from './graph/panel';
import { createLog } from './util/log';
import { RepositoriesView } from './views/repositories';
import { createStatusBar } from './views/statusBar';
import { Registry } from './workspace/registry';
import { createScmDepthCheck } from './workspace/scmDepth';

export function activate(context: vscode.ExtensionContext): void {
  const log = createLog(context);

  void vscode.commands.executeCommand('setContext', 'gitsprout.multiRepo', false);

  const registry = new Registry(log);
  const view = new RepositoriesView(registry, context.workspaceState);
  context.subscriptions.push(registry, view, createStatusBar(registry));
  registerRepoCommands(context, registry, view, log);
  registerRefViews(context, registry, log);
  const mutator = registerMutations(context, registry, log);
  registerCommitCommands(context, registry, log, mutator);
  registerGraph(context, registry, log);
  registerStubCommands(context, [...REPO_COMMAND_IDS, ...REF_COMMAND_IDS, ...MUTATION_COMMAND_IDS, ...COMMIT_COMMAND_IDS, ...GRAPH_COMMAND_IDS]);

  const checkScmDepth = createScmDepthCheck(registry, context.workspaceState, log);
  void registry.rescan().then(() => checkScmDepth());
}

export function deactivate(): void {}
