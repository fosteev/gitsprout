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
  | { type: 'state'; repo: { root: string; name: string }; /** more than one repo in the window: the toolbar shows the repo chip */ multiRepo: boolean; head: Head; commits: Commit[]; refs: Refs; wip: Status | null; settings: GraphSettings }
  /** `error` set = the file list could not be read (`files` is empty then). */
  | { type: 'details'; sha: string; files: FileStat[]; error?: string }
  | { type: 'reveal'; sha: string }                      // select + scroll (from tree views)
  | { type: 'busy'; on: boolean }
  /** A WIP operation (stage, unstage, discard, commit) is running: the webview disables every WIP button. Separate from the loading `busy`. */
  | { type: 'wipBusy'; on: boolean }
  /** The commit was made (`sha` = the new HEAD): the webview clears the draft. */
  | { type: 'committed'; sha: string }
  /** Answer to `amendInfo`: HEAD's message to prefill the draft, and whether HEAD is already on a remote; `unborn` = no commit to amend. */
  | { type: 'amendInfo'; summary: string; description: string; pushed: boolean }
  | { type: 'amendInfo'; unborn: true }
  /** No repo / log unreadable: the webview shows the message instead of the graph. */
  | { type: 'error'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; sha: string }                      // extension answers with 'details'
  | { type: 'openCommitFile'; sha: string; file: FileStat }
  | { type: 'openWipFile'; file: FileChange; area: 'staged' | 'unstaged' }
  /** WIP panel. `files` are re-checked against a fresh status; only entries still in the list are acted on. */
  | { type: 'stage'; files: FileChange[] } | { type: 'stageAll' }
  | { type: 'unstage'; files: FileChange[] } | { type: 'unstageAll' }
  | { type: 'discard'; file: FileChange } | { type: 'discardAll' }
  /** `push` = Commit and Push (ignored together with `amend`: no force push). */
  | { type: 'commit'; summary: string; description: string; amend: boolean; push: boolean }
  /** The Amend checkbox was ticked: the extension answers with `amendInfo`. */
  | { type: 'amendInfo' }
  | { type: 'openScm' } | { type: 'switchRepo' } | { type: 'refresh' }
  | { type: 'toggleCi'; hideCi: boolean }
  | { type: 'openUrl'; url: string }
  /** Copy text to the clipboard (the details card's "Copy SHA" button). */
  | { type: 'copy'; text: string };

/** Context attached to a row (`data-vscode-context`); `webview/context` commands receive it. */
export interface CommitContext { webviewSection: 'commit'; sha: string; /** the repo the row belongs to */ root: string; preventDefaultContextMenuItems: true }
