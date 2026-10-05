# Gitsprout

A VS Code (and Cursor) extension for the everyday 90% of Git work across one or many repositories: switch branches, see what changed, browse the commit graph, fetch/pull/push, stash. No subscription, no accounts, no cloud. Every action runs your own `git`, so your config, hooks and SSH keys just work.

Gitsprout adds what the built-in Source Control lacks: a commit graph with a GitKraken-style staging and commit panel, a branch/remote/stash/tag tree, and an overview of every repository in a big workspace folder.

## Features

- Workspaces with one repo or many (e.g. `~/Projects` with ~40 repos in nested folders): repository discovery, a Repositories view grouped by folder, "needs attention" filter (uncommitted / ahead / behind), Fetch All, quick repo switching, active repo follows the active editor
- Branches, Remotes, Stashes, Tags tree views for the active repo: checkout (a remote checkout creates a tracking branch), create, rename, delete, ahead/behind
- Commit graph with search, hide CI commits, commit details and Jira keys (`PROJ-123`) as links
- Inline diffs in the graph: clicking a commit or uncommitted file shows its diff in place of the graph (inline or split, next/previous file, "Open in Editor" for VS Code's native diff editor). Tree views open the native diff editor
- WIP panel in the graph: stage, unstage and discard files or everything, commit summary + description, amend, commit and push
- Graph actions: create branch/tag, reset, cherry-pick, revert, compare with working tree, save as patch
- Fetch, pull (fast-forward, merge when diverged), push with a clear message and a Pull button when rejected
- Stash: push, apply, pop, drop

Not planned: hunk/line staging, interactive rebase, conflict editor, PR/issue integrations, AI features.

## Install

- VS Code: Extensions view → search "Gitsprout", or `code --install-extension fosteev.gitsprout`
- Cursor, VSCodium and other editors on Open VSX: Extensions view → search "Gitsprout"
- From a `.vsix`: Extensions view → `…` → Install from VSIX…

Requires VS Code 1.90+ (or an editor on a matching VS Code base) and git 2.24+ on the PATH (or `git.path` set).

## Usage

- Gitsprout view in the activity bar: Repositories (multi-repo workspaces only), Branches, Remotes, Stashes, Tags. The status bar item shows the active repository and branch; the active repo follows the active editor.
- Graph tab: `Gitsprout: Show Graph` (`⌥⌘G` on macOS, `Ctrl+Alt+G` elsewhere). One tab per repository: clicking a repo in Repositories opens its graph the first time and brings the open tab back after that; focusing a graph tab makes its repo active. Tabs are restored after a window reload.
- Graph toolbar: Fetch, Pull, Push (with ahead/behind badges), Create Branch, Stash, Pop Latest Stash, Open Terminal in Repository.
- `Gitsprout: Switch Repository…`: `⌥⌘R` / `Ctrl+Alt+R`.
- Commands (Command Palette, view toolbars and context menus): Checkout…, Create Branch…, Rename/Delete Branch, Stash… (push, apply, pop, drop), Fetch, Pull, Push, Fetch All.
- WIP panel: select the `Uncommitted Changes` row at the top of the graph. Unstaged and Staged lists (Path or Tree view, Collapse All), with Stage/Unstage/Discard per file or folder (buttons and right-click menu) and Stage All / Unstage All / Discard All (Discard asks first and cannot be undone). Below: a commit summary with a 72-character counter, a description, Amend previous commit (prefilled from HEAD, with a note when HEAD is already pushed) and Commit, or Commit and Push from the ▾ menu. With nothing staged the button reads "Stage Changes to Commit" and stages everything. ⌘/Ctrl+Enter commits. Hooks run as usual; a rejected commit keeps your text. The draft is kept per tab and survives a window reload. Edits in the working tree show up in the lists within a second.
- Graph row context menu (right-click a commit): Create Branch/Tag Here, Copy SHA/Message/Link, Reset Current Branch to Here (soft/mixed/hard), Cherry Pick, Revert, Compare with Working Tree, Save as Patch. Branch and tag trees add Set Upstream, Copy Link to Branch, Delete/Push Tag. Compare with Working Tree lists tracked files only (untracked files are not shown); Save as Patch is unavailable for merge commits.
- Pull is `git pull --no-rebase --no-edit` (fast-forward when possible, a merge when diverged). Push of a branch without upstream is offered as "Publish Branch".
- A fetch is killed after 300 s in total. Pull and Push show a cancellable progress notification.
- Failed git calls show a notification. Fetch/pull/push errors offer "Show Command Output" (the `Gitsprout` output channel has the full stderr); authentication failures offer "Run in Terminal", which types the same git command into a terminal without pressing Enter.
- Timings of the repository scan and of every graph load are logged to the `Gitsprout` output channel.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `gitsprout.scanDepth` | `3` | How deep to scan workspace folders for repositories |
| `gitsprout.scanExclude` | `["**/node_modules", "**/vendor"]` | Glob patterns skipped during discovery |
| `gitsprout.followActiveEditor` | `true` | Switch the active repository to the one containing the active editor |
| `gitsprout.fetchConcurrency` | `4` | Repositories fetched in parallel by Fetch All |
| `gitsprout.logLimit` | `1000` | Maximum number of commits loaded into the graph |
| `gitsprout.ciPattern` | `^AutoBuild$` | Regular expression matching CI commit subjects |
| `gitsprout.hideCi` | `false` | Hide CI commits in the graph (also toggled from the graph toolbar) |
| `gitsprout.jira` | `{}` | Jira project key → browse URL prefix; keys in commit messages become links |

Example for Jira links:

```json
"gitsprout.jira": {
  "PROJ": "https://jira.example.com/browse/",
  "OPS": "https://example.atlassian.net/browse/"
}
```

## Development

```
pnpm install
pnpm build            # esbuild: dist/extension.js + dist/webview.js
pnpm typecheck
pnpm test             # vitest: parsers, graph layout, discovery, git integration on temp repos
pnpm package          # -> gitsprout-<version>.vsix
```

F5 in VS Code ("Run Extension") opens an Extension Development Host.

Stack: VS Code extension API, TypeScript, esbuild; the graph webview is plain TypeScript themed with `--vscode-*` variables; git runs through the system CLI (`git status --porcelain=v2`, `git log --format=…`, `git for-each-ref`), no libgit2.

## License

[MIT](LICENSE)
