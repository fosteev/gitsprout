import * as vscode from 'vscode';
import type { Registry } from '../workspace/registry';
import { statusBarModel } from './repoModel';

/** Left status bar item: active repo name (several repos) or "Gitsprout" (one repo). */
export function createStatusBar(registry: Registry): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('gitsprout.repo', vscode.StatusBarAlignment.Left, 0);
  item.name = 'Gitsprout';
  const update = () => {
    const m = statusBarModel(registry.repos, registry.active);
    if (!m) { item.hide(); return; }
    item.text = m.text;
    item.tooltip = m.tooltip;
    item.command = m.command;
    item.show();
  };
  update();
  return vscode.Disposable.from(item, registry.onDidChangeRepos(update), registry.onDidChangeActive(update));
}
