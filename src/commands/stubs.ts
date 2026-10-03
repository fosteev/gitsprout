import * as vscode from 'vscode';
import { COMMAND_IDS } from './ids';

// Commands that stages have not implemented yet stay stubs; `implemented` are skipped.
export function registerStubCommands(context: vscode.ExtensionContext, implemented: readonly string[] = []): void {
  for (const id of COMMAND_IDS) {
    if (implemented.includes(id)) continue;
    context.subscriptions.push(
      vscode.commands.registerCommand(`gitsprout.${id}`, () => {
        void vscode.window.showInformationMessage('Gitsprout: not implemented yet.');
      }),
    );
  }
}
