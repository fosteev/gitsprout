import * as vscode from 'vscode';
import { COMMAND_IDS } from './ids';

// Stage 1: every command is a stub. Real implementations replace these in later stages.
export function registerStubCommands(context: vscode.ExtensionContext): void {
  for (const id of COMMAND_IDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gitsprout.${id}`, () => {
        void vscode.window.showInformationMessage('Gitsprout: not implemented yet.');
      }),
    );
  }
}
