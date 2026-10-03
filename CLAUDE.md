# Gitsprout — repo rules

Small desktop Git client (Tauri 2 + React/TS). Every git action shells out to the system `git` CLI.

## Language

- Everything in the repo is English: code, comments, docs, roadmap, commit messages, UI copy.
- Talk to the user in Russian.

## Sources of truth

- `roadmap-mvp.md` — stages, checkboxes, the Rust ↔ TS command contract. Executors tick checkboxes as they verify them.
- `prototype/gitsprout.html` — reference for look and behaviour (layout, CSS tokens, copy, toasts, menus). When the UI is unclear, copy the prototype.
- `README.md` — product scope. Anything outside it is out of scope for MVP.

## Layout (target)

```
src/                 React UI (Vite)
  api/               typed invoke() wrappers + types mirroring Rust
  state/             zustand store
  graph/             lane layout (pure, unit-tested)
  components/        UI pieces
  styles/            CSS ported from the prototype
src-tauri/src/
  git/run.rs         spawn git, error classification
  git/parse.rs       pure parsers + unit tests
  git/ops.rs         read/write operations
  commands.rs        #[tauri::command] layer
  settings.rs        repo tabs persistence
src-tauri/tests/     integration tests on temp repos
prototype/           clickable HTML prototype
```

## Commands

```
export PATH=/opt/homebrew/opt/rustup/bin:$PATH   # brew rustup is keg-only; needed for cargo and pnpm tauri
pnpm install
pnpm tauri dev                       # run the app
pnpm build                           # tsc + vite build
pnpm test                            # vitest
cd src-tauri && cargo test           # parsers + integration tests
cd src-tauri && cargo clippy -- -D warnings
```

## Rules

- Git is invoked only through `git/run.rs`. Always `-C <repo>`, env `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` for read commands. Never parse localized or colored output.
- Parsers are pure functions over strings and have unit tests with literal fixtures.
- No libgit2, no git2 crate.
- Commit messages: imperative English summary (`Add stash panel`), no AI attribution trailers.
- macOS is the only target for MVP.
