import { basename } from 'node:path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { GitError, type Refs } from '../git/types';
import { shaFromArg } from '../graph/validate';
import type { Registry } from '../workspace/registry';
import {
  branchNameError, buildCheckoutEntries, deleteDetail, existingBranchNote, localBranchFromArg, localNameOf, pullMessage, pushMessage,
  refNameFromArg, remoteBranchFromArg, resolveStashIndex, rootFromArg, shortSha, stashShaFromArg, TAG_CHECKOUT_MESSAGE, type Op,
} from './messages';
import { createReporter } from './report';
import { checkedOutInMessage } from './worktreeHelpers';
import { checkedOutElsewhere } from '../views/refsModel';

/** Ids implemented here; `registerStubCommands` skips them. */
export const MUTATION_COMMAND_IDS = [
  'pull', 'push', 'checkout', 'checkoutBranch', 'checkoutRemote', 'createBranch', 'createBranchFrom', 'renameBranch',
  'deleteBranch', 'stash', 'stashApply', 'stashPop', 'stashDrop', 'copyBranchName', 'openSourceControl',
] as const;

const flash = (m: string): void => { vscode.window.setStatusBarMessage(`Gitsprout: ${m}`, 3000); };

export interface Target { root: string; name: string; repo: Repo }

/** What `registerMutations` hands to other command modules: the same repo targeting, serialised mutation and failure report. */
export interface Mutator {
  target: (root?: unknown) => Target | undefined;
  mutate: (t: Target, op: Op, work: (signal?: AbortSignal) => Promise<string | void>, progress?: string) => Promise<boolean>;
  fail: (e: unknown, op: Op, root: string, branch?: string | null) => Promise<void>;
}

/**
 * Repo-changing commands. They act on the active repo (the trees and the graph show it). Every mutation refreshes
 * the repo through the registry afterwards, which reloads the trees and the graph; failures go through `errorPlan`.
 */
export function registerMutations(context: vscode.ExtensionContext, registry: Registry, log: (m: string) => void): Mutator {
  const fail = createReporter(() => registry.gitPath, log);
  const busy = new Set<string>();

  const reg = (id: (typeof MUTATION_COMMAND_IDS)[number], fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`gitsprout.${id}`, fn));

  /** The repo to act on: `root` when a notification button passes the repo the error came from, else the active repo. */
  const target = (root?: unknown): Target | undefined => {
    const a = (typeof root === 'string' && registry.get(root)) || registry.active;
    if (!a) { void vscode.window.showInformationMessage('Gitsprout: no repository.'); return undefined; }
    return { root: a.root, name: a.name, repo: new Repo(a.root, registry.gitPath) };
  };

  /**
   * One mutation: serialised per repo, optional progress, repo refresh afterwards (also after a failure: a conflicting
   * merge changes the repo too), failure notification. `work` returns the success text (info notification) or void.
   * With `progress` the notification has Cancel, which aborts `signal` (kills git and its children; nothing is shown).
   */
  async function mutate(t: Target, op: Op, work: (signal?: AbortSignal) => Promise<string | void>, progress?: string): Promise<boolean> {
    if (busy.has(t.root)) {
      void vscode.window.showInformationMessage(`Gitsprout: another operation is still running in ${t.name}.`);
      return false;
    }
    busy.add(t.root);
    let message: string | void;
    try {
      message = progress
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: progress, cancellable: true }, (_, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return work(ac.signal);
        })
        : await work();
    } catch (e) {
      busy.delete(t.root);
      await registry.refreshRepo(t.root);
      await fail(e, op, t.root, registry.get(t.root)?.branch);
      return false;
    }
    busy.delete(t.root);
    await registry.refreshRepo(t.root);
    if (message) void vscode.window.showInformationMessage(message);
    return true;
  }

  // ---- pull / push ----

  reg('pull', async (root?: unknown) => {
    const t = target(root);
    if (!t) return;
    const up = registry.get(t.root)?.upstream;
    await mutate(t, 'pull', async (signal) => {
      const before = await t.repo.summary();
      await t.repo.pull({ signal });
      return pullMessage(before, await t.repo.summary());
    }, `Pulling${up ? ` from ${up}` : ''}…`);
  });

  reg('push', async (root?: unknown) => {
    const t = target(root);
    if (!t) return;
    const up = registry.get(t.root)?.upstream;
    await mutate(t, 'push', async (signal) => {
      const before = await t.repo.summary();
      await t.repo.push({ signal });
      return pushMessage(before, await t.repo.summary());
    }, `Pushing${up ? ` to ${up}` : ''}…`);
  });

  // ---- checkout ----

  const checkoutLocal = async (t: Target, name: string): Promise<void> => {
    let refs: Refs;
    try { refs = await t.repo.refs(); } catch (e) { await fail(e, 'checkout', t.root); return; }
    if (refs.head.branch === name) return;
    // Checked out in another worktree: git would refuse, so don't call it.
    const there = refs.locals.find((b) => b.name === name);
    if (there?.worktree && checkedOutElsewhere(there, t.root)) {
      const pick = await vscode.window.showWarningMessage(checkedOutInMessage(name, basename(there.worktree)), 'Open Worktree Graph', 'Open in New Window');
      if (pick === 'Open Worktree Graph') await vscode.commands.executeCommand('gitsprout.worktreeOpenGraph', there.worktree);
      else if (pick === 'Open in New Window') await vscode.commands.executeCommand('gitsprout.worktreeOpenWindow', there.worktree);
      return;
    }
    if (await mutate(t, 'checkout', () => t.repo.checkout(name))) flash(`switched to ${name}`);
  };

  const checkoutRemote = async (t: Target, remote: string): Promise<void> => {
    const local = localNameOf(remote);
    let refs: Refs;
    try { refs = await t.repo.refs(); } catch (e) { await fail(e, 'checkout', t.root); return; }
    const existing = refs.locals.find((b) => b.name === local);
    if (existing && refs.head.branch === local) return;
    await mutate(t, 'checkout', async () => {
      await t.repo.checkoutRemote(remote);
      return existing ? existingBranchNote(existing, remote) : `Created branch '${local}' tracking '${remote}'.`;
    });
  };

  reg('checkoutBranch', async (arg?: unknown) => {
    const name = localBranchFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!name) { void vscode.window.showInformationMessage('Gitsprout: use Checkout… or the Branches view.'); return; }
    await checkoutLocal(t, name);
  });

  reg('checkoutRemote', async (arg?: unknown) => {
    const name = remoteBranchFromArg(arg);
    const t = target(rootFromArg(arg));
    if (!t) return;
    if (!name) { void vscode.window.showInformationMessage('Gitsprout: use Checkout… or the Remotes view.'); return; }
    await checkoutRemote(t, name);
  });

  reg('checkout', async () => {
    const t = target();
    if (!t) return;
    let refs: Refs;
    try { refs = await t.repo.refs(); } catch (e) { await fail(e, 'checkout', t.root); return; }
    type Item = vscode.QuickPickItem & { entry?: ReturnType<typeof buildCheckoutEntries>[number] };
    const icon = { create: '$(add)', local: '$(git-branch)', remote: '$(cloud)', tag: '$(tag)' } as const;
    const items: Item[] = buildCheckoutEntries(refs, t.root).map((e): Item => e.kind === 'separator'
      ? { label: e.label, kind: vscode.QuickPickItemKind.Separator }
      : { label: `${icon[e.kind]} ${e.label}`, description: e.kind === 'create' ? undefined : e.description, entry: e });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a ref to checkout', matchOnDescription: true });
    const e = pick?.entry;
    if (!e) return;
    if (e.kind === 'create') await vscode.commands.executeCommand('gitsprout.createBranch');
    else if (e.kind === 'local') await checkoutLocal(t, e.name);
    else if (e.kind === 'remote') await checkoutRemote(t, e.name);
    else void vscode.window.showWarningMessage(TAG_CHECKOUT_MESSAGE);
  });

  // ---- branches ----

  const createFrom = async (start: string, startLabel: string, root?: string): Promise<void> => {
    const t = target(root);
    if (!t) return;
    let existing: string[];
    try { existing = (await t.repo.refs()).locals.map((b) => b.name); } catch (e) { await fail(e, 'create', t.root); return; }
    const name = await vscode.window.showInputBox({
      prompt: `Please provide a new branch name (from ${startLabel}). Press 'Enter' to confirm or 'Escape' to cancel.`,
      placeHolder: 'Branch name',
      validateInput: (v) => branchNameError(v, existing) || undefined,
    });
    if (name === undefined) return;
    // The new branch is checked out; --no-track inside Repo.createBranch (Push publishes it).
    if (await mutate(t, 'create', () => t.repo.createBranch(name, start, true))) flash(`created and switched to ${name}`);
  };

  // `root` comes from the graph toolbar (the tab's repo); the palette acts on the active repo.
  reg('createBranch', (root?: unknown) => {
    const r = typeof root === 'string' ? root : undefined;
    return createFrom('HEAD', (r ? registry.get(r) : registry.active)?.branch ?? 'HEAD', r);
  });

  reg('createBranchFrom', (arg?: unknown) => {
    // Tree nodes first (a Tag also has a `sha`); the graph passes its row context `{ sha, … }`.
    const ref = refNameFromArg(arg);
    if (ref) return createFrom(ref, ref);
    const sha = shaFromArg(arg);
    if (sha) return createFrom(sha, shortSha(sha), rootFromArg(arg)); // a graph row: its own repo, not the active one
    return createFrom('HEAD', registry.active?.branch ?? 'HEAD');
  });

  reg('renameBranch', async (arg?: unknown) => {
    const old = localBranchFromArg(arg);
    const t = target();
    if (!t) return;
    if (!old) { void vscode.window.showInformationMessage('Gitsprout: use the Branches view.'); return; }
    let existing: string[];
    try { existing = (await t.repo.refs()).locals.map((b) => b.name); } catch (e) { await fail(e, 'rename', t.root); return; }
    const name = await vscode.window.showInputBox({
      prompt: `Please provide a new name for '${old}'.`, placeHolder: 'Branch name', value: old,
      validateInput: (v) => branchNameError(v, existing, old) || undefined,
    });
    if (name === undefined || name === old) return;
    await mutate(t, 'rename', () => t.repo.renameBranch(old, name));
  });

  reg('deleteBranch', async (arg?: unknown) => {
    const name = localBranchFromArg(arg);
    const t = target();
    if (!t) return;
    if (!name) { void vscode.window.showInformationMessage('Gitsprout: use the Branches view.'); return; }
    let refs: Refs;
    try { refs = await t.repo.refs(); } catch (e) { await fail(e, 'delete', t.root); return; }
    const b = refs.locals.find((x) => x.name === name);
    if (!b) { void vscode.window.showErrorMessage(`Gitsprout: the branch '${name}' no longer exists.`); return; }
    if (refs.head.branch === name) {
      void vscode.window.showErrorMessage(`Can't delete the checked-out branch '${name}'. Check out another branch first.`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the branch '${name}'?`, { modal: true, detail: deleteDetail(b) }, 'Delete Branch');
    if (ok !== 'Delete Branch') return;
    await mutate(t, 'delete', async () => {
      try {
        await t.repo.deleteBranch(name, false);
      } catch (e) {
        if (!(e instanceof GitError) || e.kind !== 'NotFullyMerged') throw e;
        const force = await vscode.window.showWarningMessage(
          `The branch '${name}' is not fully merged.`,
          { modal: true, detail: 'Deleting it loses commits that no other branch contains. They will only be reachable through the reflog.' },
          'Delete Anyway');
        if (force !== 'Delete Anyway') return;
        await t.repo.deleteBranch(name, true);
      }
    });
  });

  reg('copyBranchName', async (arg?: unknown) => {
    const name = refNameFromArg(arg) ?? registry.active?.branch ?? undefined;
    if (!name) return;
    await vscode.env.clipboard.writeText(name);
    flash('name copied');
  });

  // ---- stash ----

  reg('stash', async (root?: unknown) => {
    const t = target(root);
    if (!t) return;
    let changes: number;
    try { changes = (await t.repo.summary()).changes; } catch (e) { await fail(e, 'stash', t.root); return; }
    if (!changes) { void vscode.window.showInformationMessage('There are no changes to stash.'); return; }
    const msg = await vscode.window.showInputBox({
      prompt: "Optionally provide a stash message. Press 'Enter' to confirm or 'Escape' to cancel.", placeHolder: 'Stash message',
    });
    if (msg === undefined) return;
    if (await mutate(t, 'stash', () => t.repo.stashPush(msg.trim() || undefined))) flash('changes stashed (untracked files included)');
  });

  /** The stash of a tree node, found by sha: indexes shift, and git wants `stash@{i}` for apply/pop/drop. */
  const findStash = async (t: Target, arg: unknown) => {
    const sha = stashShaFromArg(arg);
    if (!sha) { void vscode.window.showInformationMessage('Gitsprout: use the Stashes view.'); return undefined; }
    const stashes = await t.repo.stashes();
    const stash = stashes.find((s) => s.sha === sha);
    if (!stash) {
      void vscode.window.showErrorMessage('Gitsprout: that stash no longer exists (it was applied, dropped or the list changed).');
      return undefined;
    }
    return stash;
  };

  /** Index of the stash right before running: the list may have changed since the click (or while a modal was open). */
  const indexNow = async (t: Target, sha: string): Promise<number> => {
    const index = resolveStashIndex(await t.repo.stashes(), sha);
    if (index === undefined) throw new GitError('Other', 'the stash no longer exists', '', []);
    return index;
  };

  /** A tree node acts on its stash; a repo root (the graph toolbar's Pop) acts on that repo's latest stash. */
  const stashAction = (op: 'apply' | 'pop') => async (arg?: unknown) => {
    const t = target(arg);
    if (!t) return;
    let s;
    try {
      if (typeof arg === 'string') {
        s = (await t.repo.stashes())[0];
        if (!s) { void vscode.window.showInformationMessage('There are no stashes.'); return; }
      } else s = await findStash(t, arg);
    } catch (e) { await fail(e, op, t.root); return; }
    if (!s) return;
    const sha = s.sha;
    const ok = await mutate(t, op, async () => {
      const index = await indexNow(t, sha);
      await (op === 'apply' ? t.repo.stashApply(index) : t.repo.stashPop(index));
    });
    if (ok) flash(op === 'apply' ? 'stash applied' : 'stash popped');
  };
  reg('stashApply', stashAction('apply'));
  reg('stashPop', stashAction('pop'));

  reg('stashDrop', async (arg?: unknown) => {
    const t = target();
    if (!t) return;
    let s;
    try { s = await findStash(t, arg); } catch (e) { await fail(e, 'drop', t.root); return; }
    if (!s) return;
    const sha = s.sha;
    const ok = await vscode.window.showWarningMessage(
      `Are you sure you want to drop stash@{${s.index}}?`, { modal: true, detail: s.message }, 'Drop Stash');
    if (ok !== 'Drop Stash') return;
    await mutate(t, 'drop', async () => { await t.repo.stashDrop(await indexNow(t, sha)); });
  });

  reg('openSourceControl', () => vscode.commands.executeCommand('workbench.view.scm'));

  return { target, mutate, fail };
}
