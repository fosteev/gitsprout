# Gitsprout

A VS Code (and Cursor) extension for the everyday 90% of Git work across one or many repositories: switch branches, see what changed, browse the commit graph, fetch/pull/push, stash. No subscription, no accounts, no cloud. Every action runs your own `git`, so your config, hooks and SSH keys just work.

Staging and committing stay in VS Code's built-in Source Control. Gitsprout adds what it lacks: a commit graph, a branch/remote/stash/tag tree, and an overview of every repository in a big workspace folder.

## Scope (MVP)

- Workspaces with one repo or many (e.g. `~/Projects` with ~40 repos in nested folders): repository discovery, a Repositories view grouped by folder, "needs attention" filter (uncommitted / ahead / behind), Fetch All, quick repo switching, active repo follows the active editor
- Branches, Remotes, Stashes, Tags tree views for the active repo: checkout (a remote checkout creates a tracking branch), create, rename, delete, ahead/behind
- Commit graph (webview) with search, hide CI commits (`AutoBuild`), commit details, Jira keys (`P7-4040`, `NEWMFC-123`) as links
- Diffs open in VS Code's native diff editor (commit files, stash files, uncommitted files)
- Fetch, pull (fast-forward, merge when diverged), push with a clear message and a Pull button when rejected
- Stash: push, apply, pop, drop

Not planned for MVP: staging/commit UI (built-in SCM does it), interactive rebase, conflict editor, PR/issue integrations, AI features.

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
