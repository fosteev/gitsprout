import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import * as vscode from 'vscode';
import { Repo, type WorktreeSpec } from '../git/repo';
import { GitError, type Refs, type Worktree } from '../git/types';
import type { GraphApi } from '../graph/panel';
import { shaFromArg } from '../graph/validate';
import { currentWorktrees, worktreeLabel } from '../views/worktreeModel';
import { inside } from '../workspace/model';
import type { Registry } from '../workspace/registry';
import { branchNameError, localBranchFromArg, shortSha } from './messages';
import type { Mutator, Target } from './mutations';
import {
  buildCreateEntries, checkedOutInMessage, createdMessage, defaultWorktreePath, expandHome, lockedMessage, pruneDetail, removeDetail,
  removeTitle, worktreeFolderName, worktreePathFromArg, worktreePathError, type CreateEntry, type PathProbe,
} from './worktreeHelpers';

/** Ids implemented here; `registerStubCommands` skips them. */
export const WORKTREE_COMMAND_IDS = [
  'worktreeCreate', 'worktreeCreateFrom', 'worktreeOpenGraph', 'worktreeOpenWindow', 'worktreeOpenHere', 'worktreeAddToWorkspace',
  'worktreeTerminal', 'worktreeReveal', 'worktreeCopyPath', 'worktreeRemove', 'worktreeUnlock', 'worktreePrune', 'switchWorktree',
] as const;

type NoPath<T> = T extends unknown ? Omit<T, 'path'> : never;

function probe(path: string): PathProbe {
  try {
    const st = statSync(path);
    return { exists: true, isDir: st.isDirectory(), empty: st.isDirectory() && readdirSync(path).length === 0 };
  } catch {
    return { exists: false, isDir: false, empty: false };
  }
}

const folderPaths = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

/** Worktree commands: Create (4 kinds of start point), open (graph, windows, workspace, terminal), remove, unlock, prune. */
export function registerWorktreeCommands(
  context: vscode.ExtensionContext, registry: Registry, graph: GraphApi, m: Mutator, log: (msg: string) => void,
): void {
  const { target, mutate, fail } = m;
  const reg = (id: (typeof WORKTREE_COMMAND_IDS)[number], fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`gitsprout.${id}`, fn));
  const info = (text: string, ...actions: string[]) => vscode.window.showInformationMessage(text, ...actions);
  const warn = (text: string, ...actions: string[]) => vscode.window.showWarningMessage(text, ...actions);

  /**
   * The repo to run worktree git calls in: the main worktree when it is on disk (the active repo may itself be
   * the worktree being removed), else the active repo.
   */
  const opTarget = (list: readonly Worktree[], active: Target): Target => {
    const main = list.find((w) => w.main && !w.bare && w.prunable === null);
    if (!main || main.path === active.root) return active;
    return { root: main.path, name: basename(main.path), repo: new Repo(main.path, registry.gitPath) };
  };

  /** The worktrees of the active repo with the targets to read and run git in; undefined (and reported) on failure. */
  async function loadWorktrees(): Promise<{ active: Target; t: Target; list: Worktree[] } | undefined> {
    const active = target();
    if (!active) return undefined;
    let list: Worktree[];
    try { list = await active.repo.worktrees(); } catch (e) { await fail(e, 'worktreeAdd', active.root); return undefined; }
    return { active, t: opTarget(list, active), list };
  }

  /** A worktree needs a registry entry for its graph, WIP panel and status bar; outside the workspace folders it is added on demand. */
  async function ensureRegistered(path: string): Promise<boolean> {
    if (registry.get(path)) return true;
    if (folderPaths().some((f) => inside(f, path) !== null)) {
      await registry.rescan();
      if (registry.get(path)) return true;
    }
    await registry.addRoot(path);
    return !!registry.get(path);
  }

  const missing = async (w: { path: string }): Promise<boolean> => {
    if (existsSync(w.path)) return false;
    const pick = await warn(`${basename(w.path)} is missing on disk. Prune it?`, 'Prune');
    if (pick === 'Prune') await vscode.commands.executeCommand('gitsprout.worktreePrune');
    return true;
  };

  const openGraph = async (path: string): Promise<void> => {
    if (await missing({ path })) return;
    if (!(await ensureRegistered(path))) { void vscode.window.showErrorMessage(`Gitsprout: ${path} is not a Git working tree.`); return; }
    await vscode.commands.executeCommand('gitsprout.showGraph', path);
  };
  const openFolder = async (path: string, forceNewWindow: boolean): Promise<void> => {
    if (await missing({ path })) return;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceNewWindow });
  };
  const addToWorkspace = async (path: string): Promise<void> => {
    if (await missing({ path })) return;
    if (folderPaths().includes(path)) { void info(`${basename(path)} is already a workspace folder.`); return; }
    vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders ?? []).length, 0, { uri: vscode.Uri.file(path) });
  };

  /** Without a path (palette) there is nothing to act on: the commands live on tree rows and menus. */
  const withPath = (fn: (path: string) => unknown) => (arg?: unknown) => {
    const path = worktreePathFromArg(arg);
    if (!path) { void info('Gitsprout: pick a worktree in the Worktrees view.'); return; }
    return fn(path);
  };

  reg('worktreeOpenGraph', withPath(openGraph));
  reg('worktreeOpenWindow', withPath((p) => openFolder(p, true)));
  reg('worktreeOpenHere', withPath((p) => openFolder(p, false)));
  reg('worktreeAddToWorkspace', withPath(addToWorkspace));
  reg('worktreeTerminal', withPath(async (path) => {
    if (await missing({ path })) return;
    vscode.window.createTerminal({ name: basename(path), cwd: path }).show();
  }));
  reg('worktreeReveal', withPath(async (path) => {
    if (await missing({ path })) return;
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
  }));
  reg('worktreeCopyPath', withPath(async (path) => { await vscode.env.clipboard.writeText(path); }));

  // ---- switch ----

  reg('switchWorktree', async () => {
    const c = await loadWorktrees();
    if (!c) return;
    const current = currentWorktrees(c.list, folderPaths());
    type Item = vscode.QuickPickItem & { w: Worktree };
    const items: Item[] = c.list.map((w) => ({
      label: `$(${w.prunable !== null ? 'warning' : w.main ? 'repo' : 'folder'}) ${worktreeLabel(w)}`,
      description: `${w.branch ?? 'detached'}${current.has(w.path) ? ' · this window' : ''}`,
      detail: w.path,
      w,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Switch Worktree', placeHolder: `Open a worktree of ${basename(c.list[0]?.path ?? c.active.root)}`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    if (pick.w.prunable !== null) { await missing(pick.w); return; }
    const how = await vscode.window.showQuickPick([
      { label: '$(graph) Open Graph', run: () => openGraph(pick.w.path) },
      { label: '$(multiple-windows) Open in New Window', run: () => openFolder(pick.w.path, true) },
      { label: '$(folder-opened) Open in This Window', run: () => openFolder(pick.w.path, false) },
      { label: '$(add) Add to Workspace', run: () => addToWorkspace(pick.w.path) },
    ], { title: worktreeLabel(pick.w), placeHolder: 'Open how?' });
    await how?.run();
  });

  // ---- create ----

  async function create(start: { fromBranch?: string; fromSha?: string }): Promise<void> {
    const c = await loadWorktrees();
    if (!c) return;
    const { t, list } = c;
    let refs: Refs;
    try { refs = await c.active.repo.refs(); } catch (e) { await fail(e, 'worktreeAdd', c.active.root); return; }
    const main = list.find((w) => w.main)?.path ?? c.active.root;
    const folder = vscode.workspace.getConfiguration('gitsprout').get<string>('worktreeFolder', '');
    const home = homedir();
    const used = list.map((w) => w.path);
    const locals = refs.locals.map((b) => b.name);

    const showBusy = async (branch: string, wtPath: string): Promise<void> => {
      const pick = await info(checkedOutInMessage(branch, basename(wtPath)), 'Open Worktree Graph', 'Open in New Window');
      if (pick === 'Open Worktree Graph') await openGraph(wtPath);
      else if (pick === 'Open in New Window') await openFolder(wtPath, true);
    };

    // Step 1: what the new worktree checks out.
    let entry: CreateEntry | undefined;
    if (start.fromBranch) {
      const b = refs.locals.find((x) => x.name === start.fromBranch);
      if (!b) { void vscode.window.showErrorMessage(`Gitsprout: the branch '${start.fromBranch}' no longer exists.`); return; }
      entry = b.worktree !== null
        ? { kind: 'busy', label: b.name, description: '', worktree: b.worktree }
        : { kind: 'branch', label: b.name, description: '' };
    } else {
      const entries = buildCreateEntries(refs, list, { fromSha: start.fromSha });
      type Item = vscode.QuickPickItem & { entry?: CreateEntry };
      const icon = (e: CreateEntry): string => e.kind === 'new' ? 'add' : e.kind === 'detached' || e.kind === 'busy' ? 'folder' : e.kind === 'remote' ? 'cloud' : 'git-branch';
      const items: Item[] = entries.map((e) => e.kind === 'separator'
        ? { label: e.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: `$(${icon(e)}) ${e.label}`, description: e.description || undefined, entry: e });
      const pick = await vscode.window.showQuickPick(items, {
        title: start.fromSha ? `Create Worktree at ${shortSha(start.fromSha)} (1/3)` : 'Create Worktree (1/3)',
        placeHolder: 'Branch to check out in the new worktree',
        matchOnDescription: true,
      });
      entry = pick?.entry;
    }
    if (!entry || entry.kind === 'separator') return;
    if (entry.kind === 'busy') { await showBusy(entry.label, entry.worktree); return; }

    // Step 2 (new branch only): its name.
    let spec: NoPath<WorktreeSpec>;
    let slug: string;
    if (entry.kind === 'new') {
      const base = start.fromSha ?? refs.head.sha;
      if (!base) { void vscode.window.showErrorMessage("Gitsprout: the repository has no commits yet, so there is nothing to branch from."); return; }
      const name = await vscode.window.showInputBox({
        title: 'Create Worktree (2/3)',
        prompt: `Please provide a new branch name (from ${start.fromSha ? shortSha(start.fromSha) : refs.head.branch ?? 'HEAD'}). Press 'Enter' to confirm or 'Escape' to cancel.`,
        placeHolder: 'Branch name',
        validateInput: (v) => branchNameError(v, locals) || undefined,
      });
      if (name === undefined) return;
      spec = { newBranch: name, base };
      slug = worktreeFolderName(name, base);
    } else if (entry.kind === 'remote') {
      spec = { track: entry.label, newBranch: entry.local };
      slug = worktreeFolderName(entry.local, '');
    } else if (entry.kind === 'detached') {
      const sha = start.fromSha ?? '';
      spec = { detach: sha };
      slug = worktreeFolderName(null, sha);
    } else {
      spec = { branch: entry.label };
      slug = worktreeFolderName(entry.label, '');
    }

    // Step 3: the folder.
    const typed = await vscode.window.showInputBox({
      title: 'Create Worktree (3/3)',
      prompt: "Folder for the worktree. Press 'Enter' to confirm or 'Escape' to cancel.",
      placeHolder: 'Folder for the worktree',
      value: defaultWorktreePath(main, slug, folder, home),
      validateInput: (v) => { const p = expandHome(v.trim(), home); return worktreePathError(p, probe(p), used) || undefined; },
    });
    if (typed === undefined) return;
    const path = resolve(expandHome(typed.trim(), home));

    const ok = await mutate(t, 'worktreeAdd', async () => { await t.repo.addWorktree({ ...spec, path } as WorktreeSpec); }, 'Creating worktree…');
    if (!ok) return;
    await ensureRegistered(path);
    await registry.refreshRepo(c.active.root);
    const pick = await info(createdMessage(basename(path), path), 'Open in New Window', 'Open Graph', 'Add to Workspace');
    if (pick === 'Open in New Window') await openFolder(path, true);
    else if (pick === 'Open Graph') await openGraph(path);
    else if (pick === 'Add to Workspace') await addToWorkspace(path);
  }

  reg('worktreeCreate', () => create({}));
  reg('worktreeCreateFrom', (arg?: unknown) => {
    const fromBranch = localBranchFromArg(arg);
    if (fromBranch) return create({ fromBranch });
    const fromSha = shaFromArg(arg);
    if (fromSha) return create({ fromSha });
    void info('Gitsprout: use the Branches view or right-click a commit in the graph.');
    return undefined;
  });

  // ---- unlock / remove / prune ----

  const unlock = async (path: string): Promise<void> => {
    const c = await loadWorktrees();
    if (!c) return;
    const w = c.list.find((x) => x.path === path);
    if (!w) { void vscode.window.showErrorMessage(`Gitsprout: ${path} is not a worktree of ${c.active.name}.`); return; }
    if (w.locked === null) { void info(`Worktree ${worktreeLabel(w)} is not locked.`); return; }
    await mutate(c.t, 'worktreeUnlock', async () => {
      await c.t.repo.unlockWorktree(path);
      return `Unlocked worktree ${worktreeLabel(w)}.`;
    });
    await registry.refreshRepo(c.active.root);
  };
  reg('worktreeUnlock', withPath(unlock));

  reg('worktreeRemove', withPath(async (path: string) => {
    const c = await loadWorktrees();
    if (!c) return;
    const w = c.list.find((x) => x.path === path);
    if (!w) { void vscode.window.showErrorMessage(`Gitsprout: ${path} is not a worktree of ${c.active.name}.`); return; }
    const name = worktreeLabel(w);
    if (w.main) { void warn('The main worktree can’t be removed.'); return; }
    if (currentWorktrees(c.list, folderPaths()).has(w.path)) { void warn('This window is opened on that worktree. Open another one first.'); return; }
    if (w.locked !== null) {
      // A locked worktree is never force-removed; offer Unlock.
      if (await warn(lockedMessage(name, w.locked), 'Unlock') === 'Unlock') await unlock(path);
      return;
    }
    if (w.prunable !== null) { await missing(w); return; }

    let changes = 0;
    try { changes = (await new Repo(path, registry.gitPath).summary()).changes; } catch { changes = registry.get(path)?.changes ?? 0; }
    const remove = changes ? 'Remove Anyway' : 'Remove';
    const removeAndBranch = 'Remove and Delete Branch';
    const pick = await vscode.window.showWarningMessage(
      removeTitle(name), { modal: true, detail: removeDetail(path, changes) }, remove, ...(w.branch ? [removeAndBranch] : []));
    if (pick !== remove && pick !== removeAndBranch) return;
    const deleteBranch = pick === removeAndBranch ? w.branch : null;

    const ok = await mutate(c.t, 'worktreeRemove', async () => {
      await c.t.repo.removeWorktree(path, changes > 0);
      return deleteBranch ? undefined : `Removed worktree ${name}.`;
    });
    if (!ok) return;
    graph.close(path);
    await registry.removeRoot(path);
    await registry.refreshRepo(c.active.root);
    if (!deleteBranch) return;
    await mutate(c.t, 'delete', async () => {
      try {
        await c.t.repo.deleteBranch(deleteBranch, false);
      } catch (e) {
        if (!(e instanceof GitError) || e.kind !== 'NotFullyMerged') throw e;
        const force = await vscode.window.showWarningMessage(
          `The branch '${deleteBranch}' is not fully merged.`,
          { modal: true, detail: 'Deleting it loses commits that no other branch contains. They will only be reachable through the reflog.' },
          'Delete Anyway');
        if (force !== 'Delete Anyway') return `Removed worktree ${name}. The branch ${deleteBranch} was kept.`;
        await c.t.repo.deleteBranch(deleteBranch, true);
      }
      return `Removed worktree ${name} and branch ${deleteBranch}.`;
    });
  }));

  reg('worktreePrune', async () => {
    const c = await loadWorktrees();
    if (!c) return;
    const gone = c.list.filter((w) => !w.main && w.prunable !== null);
    if (!gone.length) { void info('Nothing to prune: every worktree folder exists.'); return; }
    const pick = await vscode.window.showWarningMessage(
      'Prune missing worktrees?', { modal: true, detail: pruneDetail(gone.map((w) => w.path)) }, 'Prune');
    if (pick !== 'Prune') return;
    const ok = await mutate(c.t, 'worktreePrune', async () => {
      await c.t.repo.pruneWorktrees();
      return `Pruned ${gone.length} worktree record${gone.length === 1 ? '' : 's'}.`;
    });
    if (!ok) return;
    for (const w of gone) { graph.close(w.path); await registry.removeRoot(w.path); }
    await registry.refreshRepo(c.active.root);
    log(`pruned ${gone.map((w) => w.path).join(', ')}`);
  });
}
