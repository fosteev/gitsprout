import * as path from 'node:path';
import * as vscode from 'vscode';
import { sideUri } from '../diff/provider';
import { patchFileName, worktreeChanges } from '../diff/uri';
import { shaFromArg } from '../graph/validate';
import { branchLink, commitLink, splitRemoteRef, webBase } from '../git/remoteUrl';
import type { Refs } from '../git/types';
import type { Registry } from '../workspace/registry';
import {
  cherryPickDone, cherryPickEmpty, cherryPickHave, localBranchFromArg, refNameFromArg, remoteBranchFromArg, RESET_NEEDS_BRANCH, resetConfirm,
  resetDone, revertDone, revertEmpty, rootFromArg, shortSha, tagNameError, upstreamCandidates, type ResetMode,
} from './messages';
import type { Mutator } from './mutations';

/** Ids implemented here; `registerStubCommands` skips them. */
export const COMMIT_COMMAND_IDS = ['createTag', 'createAnnotatedTag', 'deleteTag', 'pushTag', 'copyCommitLink', 'copyBranchLink', 'setUpstream', 'resetSoft', 'resetMixed', 'resetHard', 'cherryPick', 'revert', 'compareWithWorktree', 'savePatch'] as const;

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

  const flash = (msg: string): void => { vscode.window.setStatusBarMessage(`Gitsprout: ${msg}`, 4000); };

  reg('copyCommitLink', async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    try {
      const remote = await t.repo.linkRemote();
      const url = remote ? await t.repo.remoteUrl(remote) : null;
      const base = url ? webBase(url) : undefined;
      if (!remote || !url || !base) {
        void vscode.window.showInformationMessage(remote && url
          ? `Gitsprout: can't build a web link from the remote URL '${url}'.` : 'Gitsprout: no remote configured.');
        return;
      }
      await vscode.env.clipboard.writeText(commitLink(base, sha));
      flash((await t.repo.isOnRemote(sha)) ? 'commit link copied' : `link copied — ${shortSha(sha)} isn't on any remote branch yet`);
    } catch (e) { void vscode.window.showErrorMessage(`Gitsprout: can't copy the link: ${e instanceof Error ? e.message : String(e)}`); }
  });

  reg('copyBranchLink', async (arg?: unknown) => {
    const t = target();
    if (!t) return;
    try {
      const refs = await t.repo.refs();
      const local = localBranchFromArg(arg);
      const full = remoteBranchFromArg(arg) ?? (local ? refs.locals.find((b) => b.name === local)?.upstream ?? undefined : undefined);
      if (!full) { void vscode.window.showInformationMessage(local ? `Gitsprout: '${local}' has no upstream branch.` : 'Gitsprout: use the Branches or Remotes view.'); return; }
      const split = splitRemoteRef(full, await t.repo.remotes());
      const url = split ? await t.repo.remoteUrl(split.remote) : null;
      const base = url ? webBase(url) : undefined;
      if (!split || !url || !base) { void vscode.window.showInformationMessage(`Gitsprout: can't build a web link for '${full}'.`); return; }
      await vscode.env.clipboard.writeText(branchLink(base, split.branch));
      flash('branch link copied');
    } catch (e) { void vscode.window.showErrorMessage(`Gitsprout: can't copy the link: ${e instanceof Error ? e.message : String(e)}`); }
  });

  reg('setUpstream', async (arg?: unknown) => {
    const name = localBranchFromArg(arg);
    const t = target();
    if (!t) return;
    if (!name) { void vscode.window.showInformationMessage('Gitsprout: use the Branches view.'); return; }
    let refs: Refs;
    try { refs = await t.repo.refs(); } catch (e) { await fail(e, 'upstream', t.root); return; }
    const current = refs.locals.find((b) => b.name === name)?.upstream ?? null;
    type Item = vscode.QuickPickItem & { remote?: string | null };
    const items: Item[] = upstreamCandidates(name, refs.remotes.map((r) => r.name), current).map((c) => ({
      label: c.name, description: c.current ? 'current' : c.sameName ? 'same name' : undefined, remote: c.name,
    }));
    if (current) items.push({ label: 'Unset Upstream', description: `stop tracking ${current}`, remote: null });
    if (!items.length) { void vscode.window.showInformationMessage('Gitsprout: there are no remote branches to track.'); return; }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Upstream branch for '${name}'` });
    if (!pick || pick.remote === undefined) return;
    const remote = pick.remote;
    await mutate(t, 'upstream', async () => {
      await t.repo.setUpstream(name, remote);
      return remote === null ? `'${name}' no longer tracks '${current}'.` : `'${name}' now tracks '${remote}'.`;
    });
  });

  // ---- reset, cherry-pick, revert (graph rows; the row's own repo) ----

  const reset = (mode: ResetMode) => async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    let branch: string | null;
    try { branch = await t.repo.currentBranch(); } catch (e) { await fail(e, 'reset', t.root); return; }
    if (!branch) { void vscode.window.showInformationMessage(RESET_NEEDS_BRANCH); return; }
    if (mode === 'hard') {
      const ok = await vscode.window.showWarningMessage(resetConfirm(branch, sha), { modal: true }, 'Reset');
      if (ok !== 'Reset') return;
    }
    await mutate(t, 'reset', async () => { await t.repo.reset(mode, sha); return resetDone(branch, sha, mode); });
  };
  reg('resetSoft', reset('soft'));
  reg('resetMixed', reset('mixed'));
  reg('resetHard', reset('hard'));

  reg('cherryPick', async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    await mutate(t, 'cherryPick', async () => {
      const branch = (await t.repo.currentBranch()) ?? 'HEAD';
      if (await t.repo.isInHead(sha)) return cherryPickHave(branch, sha);
      return (await t.repo.cherryPick(sha)) ? cherryPickDone(branch, sha) : cherryPickEmpty(branch);
    });
  });

  reg('revert', async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    await mutate(t, 'revert', async () => {
      const branch = (await t.repo.currentBranch()) ?? 'HEAD';
      return (await t.repo.revert(sha)) ? revertDone(branch, sha) : revertEmpty(branch, sha);
    });
  });

  // ---- compare with working tree, save as patch (graph rows) ----

  reg('compareWithWorktree', async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    try {
      const changes = worktreeChanges(sha, await t.repo.diffWithWorktree(sha));
      if (!changes.length) { void vscode.window.showInformationMessage(`No differences between ${shortSha(sha)} and the working tree.`); return; }
      const resources = changes.map((c) => [vscode.Uri.file(path.join(t.root, c.path)), sideUri(t.root, c.left), sideUri(t.root, c.right)]);
      await vscode.commands.executeCommand('vscode.changes', `Changes since ${shortSha(sha)}`, resources);
    } catch (e) { await fail(e, 'compare', t.root); }
  });

  reg('savePatch', async (arg?: unknown) => {
    const sha = shaFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: right-click a commit in the graph.'); return; }
    try {
      const patch = await t.repo.formatPatch(sha);
      if (!patch) { void vscode.window.showInformationMessage("Merge commits can't be saved as a patch."); return; }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(t.root, patchFileName(sha, await t.repo.commitSubject(sha)))),
        filters: { Patch: ['patch', 'diff'] },
        saveLabel: 'Save Patch',
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
      void vscode.window.showInformationMessage(`Saved patch for ${shortSha(sha)} to ${uri.fsPath}.`);
    } catch (e) { await fail(e, 'compare', t.root); }
  });
}
