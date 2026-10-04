import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import type { RepoSummary } from '../git/types';
import { buildPickEntries } from '../views/repoModel';
import type { RepositoriesView } from '../views/repositories';
import { fetchRepos, summarizeFetch } from '../workspace/fetch';
import type { Registry } from '../workspace/registry';
import { createReporter } from './report';

/** Ids implemented here; `registerStubCommands` skips them. */
export const REPO_COMMAND_IDS = [
  'switchRepository', 'refresh', 'fetch', 'fetchAll', 'repoFetch', 'repoShowGraph', 'copyRepoPath', 'toggleOnlyAttention',
] as const;

/** Tree items and inline buttons pass the node; palette/keybinding passes nothing. */
function rootFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const a = arg as { repo?: { root?: string } } | undefined;
  return a?.repo?.root;
}

export function registerRepoCommands(
  context: vscode.ExtensionContext, registry: Registry, view: RepositoriesView, log: (m: string) => void,
): void {
  const reg = (id: (typeof REPO_COMMAND_IDS)[number], fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`gitsprout.${id}`, fn));

  const fail = createReporter(() => registry.gitPath, log);

  const fetchOne = async (r: RepoSummary, signal?: AbortSignal) => {
    await new Repo(r.root, registry.gitPath).fetch({ signal });
    await registry.refreshRepo(r.root);
  };

  const fetchSingle = async (root: string | undefined) => {
    const r = (root ? registry.get(root) : undefined) ?? registry.active;
    if (!r) { void vscode.window.showInformationMessage('Gitsprout: no repository.'); return; }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Fetching ${r.name}…` }, () => fetchOne(r));
      const after = registry.get(r.root);
      if (after?.behind) void vscode.window.showInformationMessage(`${r.name}: ${after.behind} incoming commit${after.behind === 1 ? '' : 's'}.`);
    } catch (e) {
      await fail(e, 'fetch', r.root, r.branch);
    }
  };

  reg('fetch', () => fetchSingle(undefined));
  reg('repoFetch', (arg) => fetchSingle(rootFromArg(arg)));

  reg('fetchAll', async () => {
    const repos = registry.repos;
    if (!repos.length) { void vscode.window.showInformationMessage('Gitsprout: no repositories in the workspace.'); return; }
    const concurrency = Math.max(1, vscode.workspace.getConfiguration('gitsprout').get<number>('fetchConcurrency', 4));
    const { outcomes, skipped } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Fetching repositories', cancellable: true },
      (progress, token) => {
        progress.report({ message: `0/${repos.length}` });
        // Cancel stops new fetches and kills the running `git fetch` processes (they report as cancelled, not as errors).
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return fetchRepos(repos, concurrency, fetchOne, {
          signal: ac.signal,
          shouldStop: () => token.isCancellationRequested,
          onDone: (o, done) => progress.report({ increment: 100 / repos.length, message: `${done}/${repos.length} · ${o.name}` }),
        });
      },
    );
    for (const o of outcomes.filter((x) => !x.ok)) log(`fetch ${o.root}: ${o.error}`);
    const sum = summarizeFetch(outcomes, registry.repos, skipped);
    const show = 'Show Only These';
    const pick = await (sum.isError ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(
      // The Repositories view is hidden with a single repo (`gitsprout.multiRepo`), so no filter button then.
      sum.text, ...(sum.incoming.length && registry.repos.length > 1 ? [show] : []),
    );
    if (pick === show) {
      view.setOnlyAttention(true);
      void vscode.commands.executeCommand('gitsprout.repositories.focus');
    }
  });

  reg('refresh', async () => {
    await registry.rescan();
    await registry.refreshAll();
  });

  reg('switchRepository', async () => {
    const entries = buildPickEntries(registry.repos, registry.active?.root);
    if (!entries.length) { void vscode.window.showInformationMessage('Gitsprout: no repositories in the workspace.'); return; }
    type Item = vscode.QuickPickItem & { root?: string };
    const items: Item[] = entries.map((e) => e.kind === 'separator'
      ? { label: e.label, kind: vscode.QuickPickItemKind.Separator }
      : { label: `$(repo) ${e.label}`, description: e.description, root: e.root });
    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = 'Choose a repository';
    qp.matchOnDescription = true;
    qp.items = items;
    const activeRoot = registry.active?.root;
    qp.activeItems = items.filter((i) => i.root !== undefined && i.root === activeRoot);
    qp.onDidAccept(() => {
      const root = qp.selectedItems[0]?.root;
      if (root) registry.setActive(root);
      qp.hide();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });

  reg('repoShowGraph', async (arg) => {
    const root = rootFromArg(arg);
    if (root) registry.setActive(root);
    await vscode.commands.executeCommand('gitsprout.showGraph');
  });

  reg('copyRepoPath', async (arg) => {
    const root = rootFromArg(arg) ?? registry.active?.root;
    if (root) await vscode.env.clipboard.writeText(root);
  });

  reg('toggleOnlyAttention', () => view.toggleOnlyAttention());
}
