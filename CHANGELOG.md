# Changelog

## 0.1.0

First release.

- Repository discovery in workspace folders (depth and excludes configurable), Repositories view grouped by folder with a "needs attention" filter, status bar, active repo follows the active editor.
- Branches, Remotes, Stashes and Tags views: checkout (remote checkout creates a tracking branch), create, rename, delete, stash push/apply/pop/drop.
- Commit graph tab: lanes, search, hide CI commits, commit details, Jira keys as links, native diff editor for commit, stash and uncommitted files. The tab is restored after a window reload.
- Fetch, Fetch All, Pull (`--no-rebase`) and Push with progress/cancel, clear error notifications with "Pull", "Publish Branch", "Run in Terminal" (typed without Enter) and "Show Command Output".
- `Gitsprout` output channel with scan and graph timings.
