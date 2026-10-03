import * as vscode from 'vscode';
import { registerStubCommands } from './commands/stubs';
import { VIEW_IDS } from './commands/ids';
import { EmptyTreeProvider } from './views/emptyTree';

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand('setContext', 'gitsprout.multiRepo', false);
  for (const id of VIEW_IDS) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(`gitsprout.${id}`, new EmptyTreeProvider()),
    );
  }
  registerStubCommands(context);
}

export function deactivate(): void {}
