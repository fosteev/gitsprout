import * as vscode from 'vscode';
import { shaFromArg } from '../graph/validate';
import type { Registry } from '../workspace/registry';
import { refNameFromArg, rootFromArg, shortSha, tagNameError } from './messages';
import type { Mutator } from './mutations';

/** Ids implemented here; `registerStubCommands` skips them. */
export const COMMIT_COMMAND_IDS = ['createTag', 'createAnnotatedTag', 'deleteTag', 'pushTag'] as const;

/** Commands on commits (graph rows) and tags (Tags tree). Graph rows carry their repo root; trees act on the active repo. */
export function registerCommitCommands(context: vscode.ExtensionContext, _registry: Registry, _log: (m: string) => void, m: Mutator): void {
  const { target, mutate, fail } = m;
  const reg = (id: (typeof COMMIT_COMMAND_IDS)[number], fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`gitsprout.${id}`, fn));

  const createTag = (annotated: boolean) => async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    let existing: string[];
    try { existing = (await t.repo.refs()).tags.map((x) => x.name); } catch (e) { await fail(e, 'tag', t.root); return; }
    const name = await vscode.window.showInputBox({
      prompt: `Please provide a new tag name (at ${shortSha(sha)}). Press 'Enter' to confirm or 'Escape' to cancel.`,
      placeHolder: 'Tag name',
      validateInput: (v) => tagNameError(v, existing) || undefined,
    });
    if (name === undefined) return;
    let message: string | undefined;
    if (annotated) {
      const text = await vscode.window.showInputBox({
        prompt: `Please provide a message for the tag '${name}'. Press 'Enter' to confirm or 'Escape' to cancel.`,
        placeHolder: 'Tag message',
        validateInput: (v) => (v.trim() ? undefined : 'Please provide a tag message'),
      });
      if (text === undefined || !text.trim()) return; // empty = cancel
      message = text.trim();
    }
    await mutate(t, 'tag', async () => {
      await t.repo.createTag(name, sha, message);
      return `Created tag '${name}' at ${shortSha(sha)}.`;
    });
  };
  reg('createTag', createTag(false));
  reg('createAnnotatedTag', createTag(true));

  reg('deleteTag', async (arg?: unknown) => {
    const name = refNameFromArg(arg);
    const t = target();
    if (!t) return;
    if (!name) { void vscode.window.showInformationMessage('Gitsprout: use the Tags view.'); return; }
    const ok = await vscode.window.showWarningMessage(
      `Delete tag '${name}'? It stays on remotes it was pushed to.`, { modal: true }, 'Delete Tag');
    if (ok !== 'Delete Tag') return;
    await mutate(t, 'tag', async () => { await t.repo.deleteTag(name); return `Deleted tag '${name}'.`; });
  });

  reg('pushTag', async (arg?: unknown) => {
    const name = refNameFromArg(arg);
    const t = target();
    if (!t) return;
    if (!name) { void vscode.window.showInformationMessage('Gitsprout: use the Tags view.'); return; }
    // Op 'push': Auth -> Run in Terminal, Show Command Output (a rejected tag push is a plain failure, see Repo.pushTag).
    await mutate(t, 'push', async (signal) => `Pushed tag '${name}' to ${await t.repo.pushTag(name, { signal })}.`, `Pushing tag '${name}'…`);
  });
}
