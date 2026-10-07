import * as vscode from 'vscode';

/** Colour for the checked-out branch and the active repo (label and icon); contributed in package.json. */
export const CURRENT_COLOR = new vscode.ThemeColor('gitsprout.currentForeground');

const SCHEME = 'gitsprout-current';

/** `TreeItem.resourceUri` that tints the row's label: tree views can't paint a row background, a file decoration can colour its text. */
export const CURRENT_URI = vscode.Uri.from({ scheme: SCHEME, path: '/current' });

export function registerCurrentMark(): vscode.Disposable {
  return vscode.window.registerFileDecorationProvider({
    provideFileDecoration: (uri) => (uri.scheme === SCHEME ? { color: CURRENT_COLOR } : undefined),
  });
}
