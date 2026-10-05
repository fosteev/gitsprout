// Messages between the extension (src/graph/panel.ts) and the graph webview (webview/main.ts).
// Type-only imports: this file is bundled into both sides and must stay free of `vscode`/node.
import type { Commit, FileChange, FilePatch, FileStat, Head, Refs, Status } from '../git/types';

export interface GraphSettings {
  ciPattern: string;
  hideCi: boolean;
  jira: Record<string, string>;
  /** `gitsprout.logLimit`: when `commits.length` reaches it, the history is cut and the count reads "N+". */
  logLimit: number;
}

/** Buttons of the graph toolbar's action group; each runs the matching `gitsprout.*` command on the tab's repo. */
export const TOOLBAR_ACTIONS = ['fetch', 'pull', 'push', 'branch', 'stash', 'pop', 'terminal'] as const;
export type ToolbarAction = typeof TOOLBAR_ACTIONS[number];

export type ToWebview =
  | { type: 'state'; repo: { root: string; name: string }; /** more than one repo in the window: the toolbar shows the repo chip */ multiRepo: boolean; head: Head; commits: Commit[]; refs: Refs; wip: Status | null; /** stash count: Pop is disabled at 0 */ stashes: number; settings: GraphSettings }
  /** `error` set = the file list could not be read (`files` is empty then). */
  | { type: 'details'; sha: string; files: FileStat[]; error?: string }
  | { type: 'reveal'; sha: string }                      // select + scroll (from tree views)
  /** Answer to `diffCommitFile` / `diffWipFile`; `req` echoes the request, a newer request makes older answers stale. */
  | { type: 'diff'; req: number; patch: FilePatch }
  | { type: 'diff'; req: number; error: string }
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
  /** Inline diff of one file (answered with `diff`). `openCommitFile` / `openWipFile` mean "open in the native editor". */
  | { type: 'diffCommitFile'; req: number; sha: string; file: FileStat }
  | { type: 'diffWipFile'; req: number; file: FileChange; area: 'staged' | 'unstaged' }
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
  /** A toolbar action button (Fetch, Pull, Push, Branch, Stash, Pop, Terminal). */
  | { type: 'action'; action: ToolbarAction }
  | { type: 'openUrl'; url: string }
  /** Copy text to the clipboard (the details card's "Copy SHA" button). */
  | { type: 'copy'; text: string };

/** Context attached to a row (`data-vscode-context`); `webview/context` commands receive it. */
export interface CommitContext { webviewSection: 'commit'; sha: string; /** the repo the row belongs to */ root: string; preventDefaultContextMenuItems: true }
/**
 * Context of a WIP file or folder row. `path` is the file's path, or a folder's path (the command acts on every file under
 * it in that list). The `wip*` keys feed the menus' `when` clauses.
 */
export interface WipContext {
  webviewSection: 'wip'; root: string; wipArea: 'staged' | 'unstaged'; path: string; origPath: string | null;
  wipDir: boolean; /** an unstaged file row that has a Discard button */ wipCanDiscard: boolean; preventDefaultContextMenuItems: true;
}
