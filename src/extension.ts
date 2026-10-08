import * as vscode from 'vscode';
import { COMMIT_COMMAND_IDS, registerCommitCommands } from './commands/commits';
import { FONT_COMMAND_IDS, registerFontCommands } from './commands/fonts';
import { registerStubCommands } from './commands/stubs';
import { MUTATION_COMMAND_IDS, registerMutations } from './commands/mutations';
import { REF_COMMAND_IDS, registerRefViews } from './commands/refs';
import { createWipActions } from './commands/wip';
import { REPO_COMMAND_IDS, registerRepoCommands } from './commands/repos';
import { registerWorktreeCommands, WORKTREE_COMMAND_IDS } from './commands/worktrees';
import { GRAPH_COMMAND_IDS, registerGraph } from './graph/panel';
import { registerSettings, SETTINGS_COMMAND_IDS } from './settings/panel';
import { registerThemeTokens } from './theme/active';
import { createLog } from './util/log';
import { registerCurrentMark } from './views/currentMark';
import { RepositoriesView } from './views/repositories';
import { createStatusBar } from './views/statusBar';
import { WorktreesView } from './views/worktrees';
import { Registry } from './workspace/registry';
import { createScmDepthCheck } from './workspace/scmDepth';

export function activate(context: vscode.ExtensionContext): void {
  const log = createLog(context);

  void vscode.commands.executeCommand('setContext', 'gitsprout.multiRepo', false);

  registerThemeTokens(context, log);
  const registry = new Registry(log, context.workspaceState);
  const view = new RepositoriesView(registry, context.workspaceState);
  const worktrees = new WorktreesView(registry, log);
  context.subscriptions.push(registerCurrentMark(), registry, view, worktrees, createStatusBar(registry));
  registerRepoCommands(context, registry, view, log);
  registerRefViews(context, registry, log);
  const mutator = registerMutations(context, registry, log);
  registerCommitCommands(context, registry, log, mutator);
  const graph = registerGraph(context, registry, log, createWipActions(registry, log, mutator));
  registerWorktreeCommands(context, registry, graph, mutator, log);
  registerFontCommands(context, log);
  registerSettings(context, log);
  registerStubCommands(context, [...REPO_COMMAND_IDS, ...REF_COMMAND_IDS, ...MUTATION_COMMAND_IDS, ...COMMIT_COMMAND_IDS, ...GRAPH_COMMAND_IDS, ...WORKTREE_COMMAND_IDS, ...FONT_COMMAND_IDS, ...SETTINGS_COMMAND_IDS]);

  const checkScmDepth = createScmDepthCheck(registry, context.workspaceState, log);
  void registry.rescan().then(() => checkScmDepth());
}

export function deactivate(): void {}
