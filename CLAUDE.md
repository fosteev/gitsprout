# Gitsprout — repo rules

VS Code / Cursor extension (TypeScript). Every git action shells out to the system `git` CLI.

## Language

- Everything in the repo is English: code, comments, docs, roadmap, commit messages, UI copy.
- Talk to the user in Russian.

## Sources of truth

- `roadmap-vscode.md` — stages, checkboxes, git contract, webview protocol, manifest contributions. Executors tick checkboxes as they verify them.
- `prototype/vscode-multi.html` and `prototype/vscode.html` — reference for behaviour, copy, and the graph look (lane geometry, rows, details card). The real extension uses native VS Code UI wherever the prototype emulates it (tree views, quick picks, notifications, diff editor, context menus).
- `README.md` — product scope. Anything outside it is out of scope for MVP.

## Layout (target)

```
src/
  extension.ts          activate(): wiring only
  git/                  run.ts (spawn + errors), parse.ts (pure), repo.ts (ops), types.ts
  workspace/            discovery.ts (scan), registry.ts (repos, active repo, watchers)
  views/                tree data providers + status bar
  graph/                panel.ts (webview host), protocol.ts (shared message types)
  diff/                 provider.ts (gitsprout: content provider, openDiff helpers)
  commands/             command implementations
webview/                graph UI (plain TS) + layout.ts (pure) + styles.css
test/                   vitest: unit + integration on temp repos
media/                  icons
```

## Commands

```
pnpm install
pnpm build            # esbuild: dist/extension.js + dist/webview.js
pnpm watch            # rebuild on change (used by F5)
pnpm typecheck        # tsc --noEmit for extension and webview
pnpm test             # vitest run
pnpm package          # vsce package --no-dependencies → gitsprout-<ver>.vsix
```
Run the extension: F5 in VS Code ("Run Extension" launch config) opens an Extension Development Host.

## Rules

- Git is invoked only through `src/git/run.ts`: `execFile('git', ['-C', root, ...])`, env `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` for reads, `-c core.quotePath=false`. Never parse localized or colored output.
- Parsers are pure functions over strings with literal-fixture unit tests.
- The extension never stages or commits; that is the built-in Source Control's job. Cherry-pick/revert/reset may create or move commits; there is still no staging or commit UI.
- Webview ↔ extension messages are typed in `src/graph/protocol.ts` and imported by both sides.
- No runtime dependencies unless the roadmap names them; everything is bundled by esbuild.
- Commit messages: imperative English summary (`Add stash tree view`), no AI attribution trailers.
