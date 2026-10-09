# Changelog

## 0.4.0

- Syntax highlighting in the graph's inline diff (26 languages). `gitsprout.diff.highlightTheme`: `auto` takes token colours from the active VS Code colour theme (falls back to the simple palette when the theme can't be read); `simple`, `github` and `one` are fixed palettes. `gitsprout.diff.syntaxHighlighting`, `gitsprout.diff.fontFamily` and `gitsprout.diff.fontSize` tune the diff.
- Google Fonts for the diff: "Download Google Font for the Diff…" fetches a family once into extension storage and the graph uses it offline; "Remove Downloaded Google Font…" deletes it. This is the extension's only network access and happens only on request.
- Gitsprout Settings page: an editor tab over the `gitsprout.*` settings with search, User/Workspace scope, categories, per-setting reset, a live diff preview and the Google Fonts controls. Open it from the gear in the graph toolbar, the gear in the Repositories view, or "Gitsprout: Open Settings".

## 0.3.1

- The checked-out branch (Branches) and the active repository (Repositories) are highlighted: green icon and green label. The colour is themable as `gitsprout.currentForeground`.

## 0.3.0

- Git worktrees: a Worktrees view (create from a branch, remote branch, new branch or commit; open as a graph tab, in a new or this window, as a workspace folder or in a terminal; remove, unlock, prune), `gitsprout.worktreeFolder` for the default location, linked worktrees nested under their repo in Repositories, branches checked out elsewhere marked and guarded against checkout.
- The commit graph shows worktrees: a branch pill with a worktree icon for a branch checked out in another worktree, a pill for another worktree's detached HEAD, and a dashed row with the uncommitted-change count on top of each other worktree's HEAD commit (card with Open Graph / New Window / Terminal, context menu with Remove Worktree…). The `Worktrees` toolbar chip hides them.

## 0.2.0

- Hovering a node in the commit graph shows which branch the commit was made on and which other branches contain it. Git does not record the branch, so it is inferred from first-parent chains (main/master/develop first); a deleted branch is named from its merge commit's message.

## 0.1.0

First release.

- Repository discovery in workspace folders (depth and excludes configurable), Repositories view grouped by folder with a "needs attention" filter, status bar, active repo follows the active editor.
- Branches, Remotes, Stashes and Tags views: checkout (remote checkout creates a tracking branch), create, rename, delete, set upstream, copy link to branch, delete/push tag, stash push/apply/pop/drop.
- Commit graph, one tab per repository: lanes, search, hide CI commits, commit details, Jira keys as links (`gitsprout.jira`). Tabs are restored after a window reload.
- Graph toolbar: Fetch, Pull, Push with ahead/behind badges, Create Branch, Stash, Pop Latest Stash, Open Terminal in Repository.
- Graph row context menu: Create Branch/Tag Here, Copy SHA/Message/Link, Reset Current Branch to Here (soft/mixed/hard), Cherry Pick, Revert, Compare with Working Tree, Save as Patch.
- Inline diff in the graph: clicking a file in the details pane (commit files, staged/unstaged files) shows its diff in place of the graph, in Inline or Split mode. `j`/`k` switch files, `Esc` returns to the graph, "Open in Editor" opens the native diff editor. Resizable split between the graph and the details pane.
- WIP panel: select the Uncommitted Changes row to stage, unstage and discard files, folders or everything (buttons and right-click menu), see Unstaged/Staged as a path list or a tree, write a commit message (summary with a 72-character counter, description), amend the previous commit, commit, or commit and push. The draft survives tab switches and window reloads. The graph refreshes when working-tree files change.
- Fetch, Fetch All, Pull (`--no-rebase`) and Push with progress/cancel, clear error notifications with "Pull", "Publish Branch", "Run in Terminal" (typed without Enter) and "Show Command Output".
- `Gitsprout` output channel with scan and graph timings.
