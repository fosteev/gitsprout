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

/** Token kinds of the highlighted diff: the contract between the highlighter CSS (`webview/tokens.css`) and the theme resolver. */
export const TOKEN_KINDS = [
  'comment', 'keyword', 'string', 'number', 'literal', 'builtIn', 'type', 'function',
  'variable', 'property', 'tag', 'attribute', 'regexp', 'meta', 'operator', 'heading',
] as const;
export type TokenKind = typeof TOKEN_KINDS[number];

export type HighlightTheme = 'auto' | 'simple' | 'github' | 'one';
export interface TokenStyle { color?: string; italic?: boolean; bold?: boolean }
export interface FontFaceSrc { weight: number; style: string; url: string; unicodeRange?: string }

/** `gitsprout.diff.*` as the diff view needs it. */
export interface DiffStyle {
  highlight: boolean;
  theme: HighlightTheme;
  /** resolved token styles of the active VS Code theme; null unless theme === 'auto' and resolution succeeded */
  tokens: Partial<Record<TokenKind, TokenStyle>> | null;
  /** '' = the editor font */
  fontFamily: string;
  /** 0 = the editor size */
  fontSize: number;
  /** webview URIs of a downloaded Google font; [] otherwise */
  fontFaces: FontFaceSrc[];
}

/** Buttons of the graph toolbar's action group; each runs the matching `gitsprout.*` command on the tab's repo. */
export const TOOLBAR_ACTIONS = ['fetch', 'pull', 'push', 'branch', 'stash', 'pop', 'terminal'] as const;
export type ToolbarAction = typeof TOOLBAR_ACTIONS[number];

/**
 * One worktree of the repo the graph shows (prunable ones excluded). `current` = the worktree this tab is bound to, decided by
 * the extension (the webview never compares paths with the repo root: symlinks like `/var` vs `/private/var` break that).
 * `changes` = uncommitted files, 0 when unknown (summaries are read for a limited number of worktrees).
 */
export interface GraphWorktree { path: string; name: string; branch: string | null; head: string | null; changes: number; current: boolean; main: boolean }

/** What the details card's buttons of another worktree ask for; run through the `gitsprout.worktree*` commands. */
export const WORKTREE_ACTIONS = ['openGraph', 'openWindow', 'terminal'] as const;
export type WorktreeAction = typeof WORKTREE_ACTIONS[number];

export type ToWebview =
  | { type: 'state'; repo: { root: string; name: string }; /** more than one repo in the window: the toolbar shows the repo chip */ multiRepo: boolean; head: Head; commits: Commit[]; refs: Refs; wip: Status | null; /** stash count: Pop is disabled at 0 */ stashes: number; /** every worktree of the repo, this tab's own included (`current`) */ worktrees: GraphWorktree[]; settings: GraphSettings }
  /** `error` set = the file list could not be read (`files` is empty then). */
  | { type: 'details'; sha: string; files: FileStat[]; error?: string }
  | { type: 'reveal'; sha: string }                      // select + scroll (from tree views)
  /** Answer to `diffCommitFile` / `diffWipFile`; `req` echoes the request, a newer request makes older answers stale. */
  | { type: 'diff'; req: number; patch: FilePatch }
  | { type: 'diff'; req: number; error: string }
  | { type: 'busy'; on: boolean }
  /** `gitsprout.diff.*` changed (also sent after `ready`): restyles the diff without a reload. */
  | { type: 'diffStyle'; style: DiffStyle }
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
  /** The diff bar's Open File: the working tree file in a normal editor, at `line` (1-based) when given. */
  | { type: 'openWorkingFile'; path: string; line?: number }
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
  /** The gear at the end of the toolbar: opens the settings page. */
  | { type: 'openSettings' }
  | { type: 'toggleCi'; hideCi: boolean }
  /** A toolbar action button (Fetch, Pull, Push, Branch, Stash, Pop, Terminal). */
  | { type: 'action'; action: ToolbarAction }
  | { type: 'openUrl'; url: string }
  /** A button of another worktree's details card; `path` must be one of the `state.worktrees` (checked by the extension). */
  | { type: 'worktree'; action: WorktreeAction; path: string }
  /** Copy text to the clipboard (the details card's "Copy SHA" button). */
  | { type: 'copy'; text: string }
  /** Double-click on a branch pill (or a row with one branch to switch to): check the branch out. */
  | { type: 'checkout'; name: string; kind: BranchKind };

/** `remote` = a remote-tracking branch (`origin/x`): checkout creates or reuses the local branch. */
export type BranchKind = 'local' | 'remote';
/**
 * Context of a branch pill, merged by VS Code over its row's `CommitContext`: the Checkout menu items match on
 * `branchKind`. `none` (the checked-out branch, tags, another worktree's HEAD) hides them even when the row has a target.
 */
export interface BranchContext { branchKind: BranchKind | 'none'; branchName?: string }

/** Context attached to a row (`data-vscode-context`); `webview/context` commands receive it. */
export interface CommitContext {
  webviewSection: 'commit'; sha: string; /** the repo the row belongs to */ root: string; preventDefaultContextMenuItems: true;
  /** The row's only branch to switch to (`checkoutTarget`), so the row itself offers Checkout. */
  branchKind?: BranchKind; branchName?: string;
}
/** Context of another worktree's WIP row: `webview/context` commands get `path` (the worktree) and `root` (the repo of the tab). */
export interface WorktreeContext { webviewSection: 'worktree'; path: string; root: string; /** the main worktree: no Remove in its menu */ worktreeMain: boolean; preventDefaultContextMenuItems: true }
/**
 * Context of a WIP file or folder row. `path` is the file's path, or a folder's path (the command acts on every file under
 * it in that list). The `wip*` keys feed the menus' `when` clauses.
 */
export interface WipContext {
  webviewSection: 'wip'; root: string; wipArea: 'staged' | 'unstaged'; path: string; origPath: string | null;
  wipDir: boolean; /** an unstaged file row that has a Discard button */ wipCanDiscard: boolean; preventDefaultContextMenuItems: true;
}
