# Changelog

## Unreleased

- Inline diff in the commit graph: clicking a file in the details pane (commit files, staged/unstaged files) shows its diff in place of the graph, in Inline or Split mode. Click another file or press `j`/`k` to switch, `Esc` or the close button returns to the graph, "Open in Editor" opens the native diff editor.
- WIP panel in the commit graph: select the Uncommitted Changes row to stage, unstage and discard files (or everything), see Unstaged/Staged as a path list or a tree, write a commit message (summary with a 72-character counter, description), amend the previous commit, commit, or commit and push. The draft survives tab switches and window reloads. The graph now refreshes when working-tree files change.

## 0.1.0

First release.

- Repository discovery in workspace folders (depth and excludes configurable), Repositories view grouped by folder with a "needs attention" filter, status bar, active repo follows the active editor.
- Branches, Remotes, Stashes and Tags views: checkout (remote checkout creates a tracking branch), create, rename, delete, stash push/apply/pop/drop.
- Commit graph tab: lanes, search, hide CI commits, commit details, Jira keys as links, native diff editor for commit, stash and uncommitted files. The tab is restored after a window reload.
- Fetch, Fetch All, Pull (`--no-rebase`) and Push with progress/cancel, clear error notifications with "Pull", "Publish Branch", "Run in Terminal" (typed without Enter) and "Show Command Output".
- `Gitsprout` output channel with scan and graph timings.
