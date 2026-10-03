# Gitsprout

A small desktop Git client for the everyday 90%: switch branches, look at what changed, commit, push, stash. No subscription, no accounts, no cloud. Every action runs your own `git`, so your config, hooks and SSH keys just work.

## Scope (MVP)

- Repository tabs
- Local and remote branches: checkout (a remote checkout creates a tracking branch), create, rename, delete, ahead/behind counters
- Commit graph with search and an option to hide CI commits (`AutoBuild`)
- Working tree: unstaged/staged files, per-file stage/unstage, diff viewer
- Commit (summary + description, amend), commit & push
- Fetch, pull (fast-forward, merge when diverged), push with a clear message when it gets rejected
- Stash: push, apply, pop, drop
- Jira keys in commit messages (`P7-4040`, `GARM-887`) rendered as links

Not planned for MVP: interactive rebase, merge-conflict editor, PR/issue integrations, AI features.

## Stack (planned)

- [Tauri 2](https://tauri.app) shell (Rust), about 10 MB instead of an Electron bundle
- React + TypeScript UI
- Git through the system CLI (`git status --porcelain=v2`, `git log --format=…`, `git for-each-ref`), not libgit2

## Repository layout

```
prototype/gitsprout.html   clickable UI prototype, sample data, open in a browser
```
