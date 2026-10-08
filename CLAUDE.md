# Gitsprout — repo rules

VS Code / Cursor extension (TypeScript). Every git action shells out to the system `git` CLI.

## Language

- Everything in the repo is English: code, comments, docs, roadmap, commit messages, UI copy.
- Talk to the user in Russian.

## Sources of truth

Roadmaps, their `*.pending.md` files, prototypes and archived plans live in `.internal/` (git-ignored, local only: they name work instances and stay out of the public repo). New roadmaps go there too.

- `.internal/roadmap-vscode.md` — stages, checkboxes, git contract, webview protocol, manifest contributions. Executors tick checkboxes as they verify them.
- `.internal/prototype/vscode-multi.html` and `.internal/prototype/vscode.html` — reference for behaviour, copy, and the graph look (lane geometry, rows, details card). The real extension uses native VS Code UI wherever the prototype emulates it (tree views, quick picks, notifications, diff editor, context menus). Exception: the graph's file diff is rendered inline in the webview (`.internal/roadmap-inline-diff.md`); tree views still open the native diff editor.
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
  settings/             protocol.ts (shared types), model.ts (pure: manifest schema, validation), panel.ts (settings page host)
  theme/                active VS Code theme -> token colours for the diff (pure resolvers + host glue)
  fonts/                opt-in Google Fonts download (google.ts pure, store.ts host); the only network access
webview/                graph UI (plain TS) + layout.ts (pure) + styles.css; base.css (theme vars), diff.css, tokens.css (palettes)
  settings/             settings page UI (own bundle: dist/settings.js + settings.css)
test/                   vitest: unit + integration on temp repos
media/                  icons
```

## Commands

```
pnpm install
pnpm build            # esbuild: dist/extension.js + dist/webview.js + dist/settings.js
pnpm watch            # rebuild on change (used by F5)
pnpm typecheck        # tsc --noEmit for extension and webview
pnpm test             # vitest run
pnpm package          # vsce package --no-dependencies → gitsprout-<ver>.vsix
```
Run the extension: F5 in VS Code ("Run Extension" launch config) opens an Extension Development Host.

## Rules

- Git is invoked only through `src/git/run.ts`: `execFile('git', ['-C', root, ...])`, env `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` for reads, `-c core.quotePath=false`. Never parse localized or colored output.
- Parsers are pure functions over strings with literal-fixture unit tests.
- Staging and committing happen only in the graph's WIP panel (`.internal/roadmap-wip-panel.md`): whole files, no hunk staging, no conflict resolution (that stays in the built-in Source Control). Cherry-pick/revert/reset may create or move commits.
- Webview ↔ extension messages are typed in `src/graph/protocol.ts` and imported by both sides.
- No runtime dependencies unless the roadmap names them; everything is bundled by esbuild.
- Commit messages: imperative English summary (`Add stash tree view`), no AI attribution trailers.
