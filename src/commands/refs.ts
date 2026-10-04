import * as vscode from 'vscode';
import { openPlan, registerDiffProvider } from '../diff/provider';
import { stashFilePlan } from '../diff/uri';
import { createBranchesView } from '../views/branches';
import { createRemotesView } from '../views/remotes';
import { registerReveal, RefsStore } from '../views/refsStore';
import { createStashesView, type StashFileNode } from '../views/stashes';
import { createTagsView } from '../views/tags';
import type { Registry } from '../workspace/registry';

/** Ids implemented here; `registerStubCommands` skips them. */
export const REF_COMMAND_IDS = ['openStashFile'] as const;

/** Ref trees, the diff content provider and their commands. */
export function registerRefViews(context: vscode.ExtensionContext, registry: Registry, log: (m: string) => void): void {
  const store = new RefsStore(registry, log);
  const provider = registerDiffProvider(() => registry.gitPath);
  context.subscriptions.push(
    store, provider, registerReveal(),
    // Index documents of a diff go stale when the repo changes.
    registry.onDidRefreshRepo((root) => provider.invalidate(root)),
    createBranchesView(store, registry),
    createRemotesView(store, registry),
    createStashesView(store, registry),
    createTagsView(store, registry),
    vscode.commands.registerCommand('gitsprout.openStashFile', async (n?: StashFileNode) => {
      if (n?.kind !== 'stashFile') return;
      try {
        await openPlan(n.root, stashFilePlan(n.stash, n.file));
      } catch (e) {
        void vscode.window.showErrorMessage(`Gitsprout: can't open the diff: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
}
