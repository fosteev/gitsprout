// Messages between the extension (src/graph/panel.ts) and the graph webview (webview/main.ts).
// Type-only imports: this file is bundled into both sides and must stay free of `vscode`/node.
import type { Commit, FileChange, FileStat, Head, Refs, Status } from '../git/types';

export interface GraphSettings {
  ciPattern: string;
  hideCi: boolean;
  jira: Record<string, string>;
  /** `gitsprout.logLimit`: when `commits.length` reaches it, the history is cut and the count reads "N+". */
  logLimit: number;
}

export type ToWebview =
  | { type: 'state'; repo: { root: string; name: string }; head: Head; commits: Commit[]; refs: Refs; wip: Status | null; settings: GraphSettings }
  /** `error` set = the file list could not be read (`files` is empty then). */
  | { type: 'details'; sha: string; files: FileStat[]; error?: string }
  | { type: 'reveal'; sha: string }                      // select + scroll (from tree views)
  | { type: 'busy'; on: boolean }
  /** No repo / log unreadable: the webview shows the message instead of the graph. */
  | { type: 'error'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; sha: string }                      // extension answers with 'details'
  | { type: 'openCommitFile'; sha: string; file: FileStat }
  | { type: 'openWipFile'; file: FileChange; area: 'staged' | 'unstaged' }
  | { type: 'openScm' } | { type: 'switchRepo' } | { type: 'refresh' }
  | { type: 'toggleCi'; hideCi: boolean }
  | { type: 'openUrl'; url: string };

/** Context attached to a row (`data-vscode-context`); `webview/context` commands receive it. */
export interface CommitContext { webviewSection: 'commit'; sha: string; preventDefaultContextMenuItems: true }
