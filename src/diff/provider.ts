import * as path from 'node:path';
import * as vscode from 'vscode';
import { readTarget } from './content';
import { decodeQuery, isVolatileRef, SCHEME, uriParts, type DiffPlan, type DiffTarget, type Side } from './uri';

/** Serves `gitsprout:` documents: `git show <ref>:<path>` (`:` = index) of a repo; ref `""` = empty. */
export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  /** Open documents whose ref can move (index, HEAD, names), by repo root: re-read when the repo refreshes. */
  private readonly volatile = new Map<string, Map<string, vscode.Uri>>();

  constructor(private readonly gitPath: () => string) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const t = decodeQuery(uri.query);
    if (!t || t.ref === '') return '';
    if (isVolatileRef(t.ref)) {
      const m = this.volatile.get(t.root) ?? new Map<string, vscode.Uri>();
      m.set(uri.toString(), uri);
      this.volatile.set(t.root, m);
    }
    return readTarget(t, this.gitPath());
  }

  /** The repo changed (index, HEAD, refs): re-read its open volatile documents. */
  invalidate(root: string): void {
    const m = this.volatile.get(root);
    if (!m) return;
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    for (const [key, u] of m) {
      // Closed documents are forgotten (VS Code asks again when one is reopened), so the map does not grow forever.
      if (open.has(key)) this.emitter.fire(u); else m.delete(key);
    }
    if (m.size === 0) this.volatile.delete(root);
  }

  dispose(): void { this.emitter.dispose(); this.volatile.clear(); }
}

export function gitUri(t: DiffTarget): vscode.Uri {
  const p = uriParts(t);
  return vscode.Uri.from({ scheme: p.scheme, path: p.path, query: p.query });
}

export function sideUri(root: string, s: Side): vscode.Uri {
  if (s.kind === 'file') return vscode.Uri.file(path.join(root, s.path));
  return gitUri({ root, ref: s.ref, path: s.path });
}

/** Opens a plan: native diff editor, or a plain editor for untracked files. */
export async function openPlan(root: string, plan: DiffPlan): Promise<void> {
  if (plan.kind === 'open') {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root, plan.path)));
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', sideUri(root, plan.left), sideUri(root, plan.right), plan.title);
}

export function registerDiffProvider(gitPath: () => string): GitContentProvider & vscode.Disposable {
  const provider = new GitContentProvider(gitPath);
  const reg = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  const dispose = provider.dispose.bind(provider);
  provider.dispose = () => { reg.dispose(); dispose(); };
  return provider;
}
