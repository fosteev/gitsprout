import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** The `Gitsprout` output channel (created on first use; disposed with the extension context). */
export function createLog(context: vscode.ExtensionContext): (m: string) => void {
  channel = vscode.window.createOutputChannel('Gitsprout');
  context.subscriptions.push(channel, { dispose: () => { channel = undefined; } });
  const ch = channel;
  return (m) => ch.appendLine(`${new Date().toISOString()} ${m}`);
}

/** Reveals the channel without taking focus away from the editor (the "Show Command Output" action). */
export function showLog(): void { channel?.show(true); }
