# Gitsprout

A VS Code (and Cursor) extension for the everyday 90% of Git work across one or many repositories: switch branches, see what changed, browse the commit graph, fetch/pull/push, stash. No subscription, no accounts, no cloud. Every action runs your own `git`, so your config, hooks and SSH keys just work.

Gitsprout adds what the built-in Source Control lacks: a commit graph with a GitKraken-style staging and commit panel, a branch/remote/stash/tag tree, and an overview of every repository in a big workspace folder.

## Scope (MVP)

- Workspaces with one repo or many (e.g. `~/Projects` with ~40 repos in nested folders): repository discovery, a Repositories view grouped by folder, "needs attention" filter (uncommitted / ahead / behind), Fetch All, quick repo switching, active repo follows the active editor
- Branches, Remotes, Stashes, Tags tree views for the active repo: checkout (a remote checkout creates a tracking branch), create, rename, delete, ahead/behind
- Commit graph (webview) with search, hide CI commits (`AutoBuild`), commit details, Jira keys (`P7-4040`, `NEWMFC-123`) as links
- Diffs open in VS Code's native diff editor (commit files, stash files, uncommitted files)
- Fetch, pull (fast-forward, merge when diverged), push with a clear message and a Pull button when rejected
- Stash: push, apply, pop, drop
- WIP panel in the graph (post-MVP, `roadmap-wip-panel.md`): stage, unstage and discard files or everything, commit summary + description, amend, commit and push

Not planned: hunk/line staging, interactive rebase, conflict editor, PR/issue integrations, AI features.

## Install

Build the package, then install the `.vsix` (no marketplace publishing in the MVP):

```
pnpm install
pnpm package                                   # -> gitsprout-0.1.0.vsix
```

- VS Code: `code --install-extension gitsprout-0.1.0.vsix`, or Extensions view → `…` → Install from VSIX…
- Cursor: Extensions view → `…` → Install from VSIX… (or `cursor --install-extension gitsprout-0.1.0.vsix`)

Requires VS Code (or Cursor on a matching VS Code base) 1.90+ and git 2.24+ on the PATH (or `git.path` set).

## Usage

- Gitsprout view in the activity bar: Repositories (multi-repo workspaces only), Branches, Remotes, Stashes, Tags. The status bar item shows the active repository and branch; the active repo follows the active editor.
- Graph tab: `Gitsprout: Show Graph` (`⌥⌘G` on macOS, `Ctrl+Alt+G` elsewhere). One tab per repository: clicking a repo in Repositories opens its graph the first time and brings the open tab back after that; focusing a graph tab makes its repo active. Tabs are restored after a window reload.
- `Gitsprout: Switch Repository…`: `⌥⌘R` / `Ctrl+Alt+R`.
- Commands (Command Palette, view toolbars and context menus): Checkout…, Create Branch…, Rename/Delete Branch, Stash… (push, apply, pop, drop), Fetch, Pull, Push, Fetch All.
- Graph row context menu (right-click a commit): Create Branch/Tag Here, Copy SHA/Message/Link, Reset Current Branch to Here (soft/mixed/hard), Cherry Pick, Revert, Compare with Working Tree, Save as Patch. Branch and tag trees add Set Upstream, Copy Link to Branch, Delete/Push Tag. Compare with Working Tree lists tracked files only (untracked files are not shown); Save as Patch is unavailable for merge commits.
- Pull is `git pull --no-rebase --no-edit` (fast-forward when possible, a merge when diverged). Push of a branch without upstream is offered as "Publish Branch".
- A fetch is killed after 300 s in total. Pull and Push show a cancellable progress notification.
- Failed git calls show a notification. Fetch/pull/push errors offer "Show Command Output" (the `Gitsprout` output channel has the full stderr); authentication failures offer "Run in Terminal", which types the same git command into a terminal without pressing Enter.
- Timings of the repository scan and of every graph load are logged to the `Gitsprout` output channel.

Screenshots: _placeholder (to be added)._

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
| `gitsprout.jira` | Pilot, SmartCityCloud and Tatikoma projects | Jira project key → browse URL prefix; keys in commit messages become links |

## Stack

- VS Code extension API (`engines.vscode ^1.90`), TypeScript, esbuild
- Webview UI in plain TypeScript (no framework), themed with `--vscode-*` variables
- Git through the system CLI (`git status --porcelain=v2`, `git log --format=…`, `git for-each-ref`), no libgit2
- vitest for parsers, graph layout, discovery and git integration tests on temp repos
- `@vscode/vsce` to build a `.vsix`

## Repository layout

```
roadmap-vscode.md          implementation plan (stages, contract, prompts)
prototype/vscode.html      UI prototype: single-repo workspace
prototype/vscode-multi.html UI prototype: multi-repo workspace
prototype/gitsprout.html   earlier desktop-app prototype (reference only)
docs/archive/              superseded plans
```
