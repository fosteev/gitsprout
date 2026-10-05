# Changelog

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
