import * as vscode from 'vscode';
import { GitError } from '../git/types';
import { showLog } from '../util/log';
import { ACTION_LABEL, errorPlan, terminalCommand, type ActionId, type Op } from './messages';

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Shows a failed git call as a notification with the actions of `errorPlan`; logs the details. Resolves when the notification is gone. */
export function createReporter(gitPath: () => string, log: (m: string) => void) {
  const run = async (id: ActionId, root: string, e: unknown): Promise<void> => {
    switch (id) {
      // `root`: the repo the error came from, even if the active repo changed while the notification was open.
      case 'pull': await vscode.commands.executeCommand('gitsprout.pull', root); return;
      case 'publish': await vscode.commands.executeCommand('gitsprout.push', root); return;
      case 'scm': await vscode.commands.executeCommand('workbench.view.scm'); return;
      case 'stash': await vscode.commands.executeCommand('gitsprout.stash', root); return;
      case 'terminal': {
        // The same command, in the integrated terminal, where ssh/credential prompts can be answered.
        const term = vscode.window.createTerminal({ name: 'Gitsprout', cwd: root });
        term.show();
        // No Enter: the user reads the command and runs it.
        if (e instanceof GitError) term.sendText(terminalCommand(gitPath(), e.args), false);
        return;
      }
      case 'output': showLog(); return;
    }
  };

  return async function fail(e: unknown, op: Op, root: string, branch?: string | null): Promise<void> {
    const err = e instanceof GitError ? e : new GitError('Other', text(e), '', []);
    log(`${op} ${root}: [${err.kind}] ${err.message}${err.stderr ? `\n${err.stderr.trim()}` : ''}`);
    const plan = errorPlan(err, op, branch);
    if (!plan) return;
    const show = plan.level === 'error' ? vscode.window.showErrorMessage : plan.level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const labels = plan.actions.map((a) => ACTION_LABEL[a]);
    const pick = await show(plan.text, ...labels);
    const id = plan.actions.find((a) => ACTION_LABEL[a] === pick);
    if (id) await run(id, root, err);
  };
}
