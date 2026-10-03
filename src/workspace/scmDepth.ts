import * as vscode from 'vscode';
import { scmDepthCheck } from './model';
import type { Registry } from './registry';

const SILENCE_KEY = 'gitsprout.scmDepthSilenced';

/** Built-in SCM only scans `git.repositoryScanMaxDepth` levels (default 1); offer to raise it, once per session. */
export function createScmDepthCheck(registry: Registry, state: vscode.Memento, log: (m: string) => void): () => Promise<void> {
  let shown = false;
  return async () => {
    if (shown || state.get<boolean>(SILENCE_KEY, false)) return;
    const git = vscode.workspace.getConfiguration('git');
    const info = scmDepthCheck(registry.depths(), git.get<number>('repositoryScanMaxDepth', 1));
    if (!info) return;
    shown = true;
    const setDepth = `Set depth to ${info.needed}`;
    const never = "Don't ask again";
    const pick = await vscode.window.showInformationMessage(
      `Source Control sees ${info.visible} of ${info.total} repositories.`, setDepth, never,
    );
    try {
      if (pick === setDepth) await git.update('repositoryScanMaxDepth', info.needed, vscode.ConfigurationTarget.Workspace);
      else if (pick === never) await state.update(SILENCE_KEY, true);
    } catch (e) {
      log(`scm depth: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showErrorMessage(`Gitsprout: could not update git.repositoryScanMaxDepth: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
