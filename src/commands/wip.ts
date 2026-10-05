import * as vscode from 'vscode';
import type { FileChange, Status } from '../git/types';
import { commitMessage } from '../git/message';
import type { ToWebview } from '../graph/protocol';
import type { Registry } from '../workspace/registry';
import {
  changedFileCount, committedFlash, discardAllConfirm, discardDeletes, discardFileConfirm, filesUnder, matchFiles, NESTED_REPO_DISCARD, NO_COMMIT_SUMMARY,
  NOTHING_TO_DISCARD_TO,
} from './messages';
import type { Mutator, Target } from './mutations';

export interface CommitRequest { summary: string; description: string; amend: boolean; push: boolean }
export type AmendInfo = Extract<ToWebview, { type: 'amendInfo' }>;

/**
 * The WIP panel's operations, one per webview message. Each takes the repo root of the tab it came from and returns
 * whether it did its job (false = refused, cancelled or failed; failures are already shown). Files from the webview
 * are re-checked against a fresh `status()`: only entries still in the list are acted on.
 */
export interface WipActions {
  stage(root: string, files: FileChange[]): Promise<boolean>;
  stageAll(root: string): Promise<boolean>;
  unstage(root: string, files: FileChange[]): Promise<boolean>;
  unstageAll(root: string): Promise<boolean>;
  /** Stage / unstage the file at `path` or every file under that folder (a row's context menu). */
  stagePath(root: string, path: string): Promise<boolean>;
  unstagePath(root: string, path: string): Promise<boolean>;
  discard(root: string, file: Pick<FileChange, 'path' | 'origPath'>): Promise<boolean>;
  discardAll(root: string): Promise<boolean>;
  /** The new HEAD sha, or undefined when nothing was committed (refused, cancelled, failed; a push is started, not awaited). */
  commit(root: string, req: CommitRequest): Promise<string | undefined>;
  /** HEAD's message for the Amend checkbox; undefined when it can't be read. */
  amendInfo(root: string): Promise<AmendInfo | undefined>;
}

const flash = (m: string): void => { vscode.window.setStatusBarMessage(`Gitsprout: ${m}`, 3000); };

export function createWipActions(registry: Registry, log: (m: string) => void, m: Mutator): WipActions {
  const { target, mutate, fail } = m;

  /** The repo for `root` (only a root the registry knows: a closed repo gets no op) and a fresh status, or undefined after the failure was shown. */
  const fresh = async (root: string, op: 'stage' | 'unstage' | 'discard'): Promise<{ t: Target; status: Status } | undefined> => {
    if (!registry.get(root)) return undefined;
    const t = target(root);
    if (!t) return undefined;
    try {
      return { t, status: await t.repo.status() };
    } catch (e) {
      await fail(e, op, t.root);
      return undefined;
    }
  };

  const stageOrUnstage = (op: 'stage' | 'unstage', pick: (own: FileChange[]) => FileChange[]) => async (root: string): Promise<boolean> => {
    const f = await fresh(root, op);
    if (!f) return false;
    const list = pick(op === 'stage' ? f.status.unstaged : f.status.staged);
    if (list.length === 0) { await registry.refreshRepo(f.t.root); return false; } // the lists were stale: the refresh fixes the panel
    return mutate(f.t, op, () => (op === 'stage' ? f.t.repo.stage(list) : f.t.repo.unstage(list)));
  };

  const all = (op: 'stage' | 'unstage') => async (root: string): Promise<boolean> => {
    if (!registry.get(root)) return false;
    const t = target(root);
    return t ? mutate(t, op, () => (op === 'stage' ? t.repo.stageAll() : t.repo.unstageAll())) : false;
  };

  return {
    stage: (root, files) => stageOrUnstage('stage', (own) => matchFiles(files, own))(root),
    unstage: (root, files) => stageOrUnstage('unstage', (own) => matchFiles(files, own))(root),
    stagePath: (root, path) => stageOrUnstage('stage', (own) => filesUnder(path, own))(root),
    unstagePath: (root, path) => stageOrUnstage('unstage', (own) => filesUnder(path, own))(root),
    stageAll: all('stage'),
    unstageAll: all('unstage'),

    async discard(root, file) {
      const f = await fresh(root, 'discard');
      if (!f) return false;
      const [own] = matchFiles([file], f.status.unstaged);
      if (!own || own.status === 'U') { await registry.refreshRepo(f.t.root); return false; } // stale, or a conflicted file: no Discard there
      if (own.path.endsWith('/')) { void vscode.window.showInformationMessage(`Gitsprout: ${NESTED_REPO_DISCARD}`); return false; }
      const c = discardFileConfirm(own);
      const pick = await vscode.window.showWarningMessage(c.text, { modal: true, detail: c.detail }, 'Discard');
      if (pick !== 'Discard') return false;
      // The modal may stay up for a while: act on the entry as it is now, and skip if it changed in a way the modal didn't describe.
      let done = false;
      const ok = await mutate(f.t, 'discard', async () => {
        const [now] = matchFiles([own], (await f.t.repo.status()).unstaged);
        if (!now || now.status === 'U' || discardDeletes(now) !== discardDeletes(own)) return; // the refresh shows the new state
        await f.t.repo.discard(now);
        done = true;
      });
      return ok && done;
    },

    async discardAll(root) {
      const f = await fresh(root, 'discard');
      if (!f) return false;
      try {
        if ((await f.t.repo.headMessage()) === null) { void vscode.window.showInformationMessage(`Gitsprout: ${NOTHING_TO_DISCARD_TO}`); return false; }
      } catch (e) { await fail(e, 'discard', f.t.root); return false; }
      const n = changedFileCount(f.status);
      if (n === 0) { await registry.refreshRepo(f.t.root); return false; }
      const c = discardAllConfirm(n);
      const pick = await vscode.window.showWarningMessage(c.text, { modal: true, detail: c.detail }, 'Discard All');
      if (pick !== 'Discard All') return false;
      return mutate(f.t, 'discard', () => f.t.repo.discardAll());
    },

    async commit(root, req) {
      if (!registry.get(root)) return undefined;
      const message = commitMessage(req.summary, req.description);
      if (message === null) { void vscode.window.showWarningMessage(`Gitsprout: ${NO_COMMIT_SUMMARY}`); return undefined; } // the webview shows it inline; this is the backstop
      const t = target(root);
      if (!t) return undefined;
      let sha = undefined as string | undefined; // set inside `work`: a plain `let` would be narrowed to `undefined` below
      let cancelled = false; // Cancel came after the commit was made (slow post-commit hook): the commit stands, the push doesn't start
      // The draft is kept on failure (the panel posts `committed` only for a returned sha). Hooks run; Cancel kills git.
      const ok = await mutate(t, 'commit', async (signal) => {
        sha = await t.repo.commit(message, { amend: req.amend, signal });
        cancelled = signal?.aborted ?? false;
      }, 'Committing…');
      if (!ok || !sha) return undefined;
      flash(committedFlash(sha));
      // Commit and Push: the existing push flow with its own progress, errors and buttons. Not awaited: the panel must not stay busy during a push. No force push, so never after an amend.
      // `gitsprout.push` falls back to the active repo for an unknown root, so only push while this root is still registered.
      if (req.push && !req.amend && !cancelled && registry.get(t.root)) void vscode.commands.executeCommand('gitsprout.push', t.root);
      return sha;
    },

    async amendInfo(root) {
      if (!registry.get(root)) return undefined;
      const t = target(root);
      if (!t) return undefined;
      try {
        const msg = await t.repo.headMessage();
        if (!msg) return { type: 'amendInfo', unborn: true };
        const sha = (await t.repo.refs()).head.sha;
        return { type: 'amendInfo', ...msg, pushed: sha ? await t.repo.isOnRemote(sha) : false };
      } catch (e) {
        log(`amendInfo ${root}: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
  };
}
