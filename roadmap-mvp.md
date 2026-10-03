# Gitsprout MVP

> Status: draft · created 2026-10-03 · executors tick checkboxes as each step is verified, not when it "should work".

## Goal

A macOS app that replaces GitKraken for daily work on the user's repos (Pilot7, flutter-pulse-mobile, …): repo tabs, local/remote branches, commit graph, working-tree diff, stage/commit/amend, fetch/pull/push, stash. Every operation goes through the system `git`.

## Context and constraints

- Scope: `README.md`. Look and behaviour: `prototype/gitsprout.html` (layout, CSS tokens, copy, toasts, context menus, keyboard). Repo rules: `CLAUDE.md`.
- Stack (decided): Tauri 2, React 18 + TypeScript + Vite, pnpm, zustand, `@tanstack/react-virtual`, vitest. Rust side: serde, thiserror, `tempfile` (dev). Plugins: `tauri-plugin-dialog` (folder picker), `tauri-plugin-opener` (Jira links).
- No git2/libgit2. Git binary: first existing of `/opt/homebrew/bin/git`, `/usr/local/bin/git`, `/usr/bin/git`; none → `GitMissing`. GUI apps don't get the shell PATH, so never rely on `PATH`.
- Every Tauri command is `async` and runs git inside `tauri::async_runtime::spawn_blocking`, so fetch/push never freeze the window.
- Pull is `git pull --no-rebase --no-edit`: fast-forward when possible, merge commit when diverged. This matches the user's current history (`Merge remote-tracking branch 'origin/develop' into develop`).
- Refresh model: no file watcher in MVP. The UI refetches after every mutation, on window focus and on ⌘R.
- Log limit: 1000 commits (`--topo-order`). Lanes whose parent is beyond the limit run to the bottom of the graph; accepted.
- Toolchain on this Mac (checked 2026-10-03): node 22.23, pnpm 9.0, git 2.49, Xcode present, **Rust not installed**. Stage 1 installs it via `brew install rustup`.
- Assumption: `pnpm create tauri-app` accepts `--template react-ts --manager pnpm --identifier … --yes`. If it rejects a flag, run it with `--help` and use the equivalent.
- Bundle identifier: `dev.fosteev.gitsprout`. Window: title `Gitsprout`, 1400×900, min 960×600.

## Command contract (Rust ↔ TS)

Rust structs use `#[serde(rename_all = "camelCase")]`; `src/api/types.ts` mirrors them by hand. Every command takes `repo: String` (absolute path) first, except `repo_open`, `settings_*`. Errors serialize as `GitError`.

```ts
type ErrorKind = 'NotARepo' | 'GitMissing' | 'PushRejected' | 'NoUpstream' | 'Conflict'
  | 'LocalChanges' | 'NotFullyMerged' | 'Auth' | 'NothingToStash' | 'Other';
interface GitError { kind: ErrorKind; message: string; stderr: string }

interface RepoInfo { path: string; name: string; remoteUrl: string | null }
interface Head { branch: string | null; sha: string | null }           // branch null = detached, sha null = unborn
interface LocalBranch { name: string; sha: string; upstream: string | null; ahead: number; behind: number; upstreamGone: boolean }
interface RemoteBranch { name: string; sha: string }                    // "origin/develop"
interface Tag { name: string; sha: string }                             // peeled commit sha
interface Refs { head: Head; locals: LocalBranch[]; remotes: RemoteBranch[]; tags: Tag[] }
interface Commit { sha: string; parents: string[]; author: string; email: string; time: number; subject: string; body: string }
type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
interface FileChange { path: string; origPath: string | null; status: FileStatus; untracked: boolean }
interface Status { staged: FileChange[]; unstaged: FileChange[] }
interface FileStat { path: string; origPath: string | null; status: FileStatus; add: number | null; del: number | null } // null = binary/unknown
interface DiffLine { kind: 'ctx' | 'add' | 'del'; old: number | null; new: number | null; text: string }
interface Hunk { header: string; lines: DiffLine[] }
interface Diff { binary: boolean; hunks: Hunk[]; truncated: boolean }  // truncated after 5000 lines
interface Stash { index: number; sha: string; message: string }
interface Settings { repos: string[]; active: string | null; hideCi: boolean; ciPattern: string; jira: Record<string, string> }
```

| Command | Git invocation (always `git -C <repo>`) | Notes |
|---|---|---|
| `repo_open(path) → RepoInfo` | `rev-parse --show-toplevel`; `remote get-url origin` (optional) | non-repo → `NotARepo`; `name` = last path segment |
| `refs_list → Refs` | `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(*objectname) refs/heads refs/remotes refs/tags`; `symbolic-ref -q --short HEAD` (exit 1 = detached); `rev-parse -q --verify HEAD` (fails = unborn) | skip `refs/remotes/*/HEAD`; track: `ahead N, behind M` / `ahead N` / `behind M` / `gone` / empty; tag sha = `*objectname` if non-empty |
| `log(limit) → Commit[]` | `log --branches --remotes --tags HEAD --topo-order -n <limit> -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b` | drop `HEAD` arg when unborn; records split by `\0`, fields by `\x1f`; trim trailing `\n` of body |
| `status → Status` | `status --porcelain=v2 -z --untracked-files=all` | see parsing rules below |
| `diff_file(path, area) → Diff` | unstaged: `diff --no-color --no-ext-diff -- <path>`; staged: same + `--cached`; untracked: `diff --no-color --no-ext-diff --no-index -- /dev/null <path>` | `--no-index` exits 1 on differences: treat 0 and 1 as success |
| `commit_files(sha) → FileStat[]` | `diff-tree -r --root --no-commit-id -M -z --name-status <sha>` + same with `--numstat` | merge commits return `[]` (UI says "merge commit") |
| `diff_commit_file(sha, path) → Diff` | `show --format= --no-color --no-ext-diff <sha> -- <path>` | works for root commits |
| `stash_list → Stash[]` | `stash list -z --format=%gd%x1f%H%x1f%gs` | index parsed from `stash@{N}` |
| `stash_files(index) → FileStat[]` | `stash show --name-status -z --include-untracked stash@{N}` | add/del = null |
| `stash_diff_file(index, path) → Diff` | `diff --no-color --no-ext-diff stash@{N}^1 stash@{N} -- <path>`; if empty and `rev-parse -q --verify stash@{N}^3` succeeds: `show --format= --no-color stash@{N}^3 -- <path>` | ^3 holds untracked files |
| `stage(paths)` | `add -A -- <paths…>` | |
| `unstage(paths)` | `restore --staged -- <paths…>`; unborn HEAD: `rm --cached -q -- <paths…>` | |
| `stage_all` / `unstage_all` | `add -A` / `reset -q` (unborn: `rm -r --cached -q .`) | |
| `commit(summary, description, amend) → string` | `commit -F -` (+ `--amend`), message on stdin = summary + (`\n\n` + description if non-empty) | returns `rev-parse HEAD`; hooks run as usual |
| `checkout(name)` | `switch <name>` | "would be overwritten" → `LocalChanges` |
| `checkout_remote(remoteBranch)` | local = text after first `/`; exists → `switch <local>`, else `switch --track <remoteBranch>` | |
| `branch_create(name, start, checkout)` | `check-ref-format --branch <name>` first; then `branch <name> <start>` or `switch -c <name> <start>` | invalid name → `Other` with git's message |
| `branch_rename(old, new)` | `branch -m <old> <new>` | |
| `branch_delete(name, force)` | `branch -d|-D <name>` | "not fully merged" → `NotFullyMerged` |
| `fetch` | `fetch --all --prune` | |
| `pull` | no upstream → `NoUpstream`; else `pull --no-rebase --no-edit` | output contains `CONFLICT` or `Automatic merge failed` → `Conflict` |
| `push` | upstream set → `push`; else `push -u <remote> HEAD`, remote = first line of `git remote` (none → `Other`) | stderr `[rejected]`, `non-fast-forward`, `fetch first` → `PushRejected` |
| `stash_push(message?)` | `stash push -u [-m <message>]` | "No local changes to save" → `NothingToStash` |
| `stash_apply(i)` / `stash_pop(i)` / `stash_drop(i)` | `stash apply|pop|drop stash@{i}` | conflict → `Conflict` |
| `settings_load → Settings` / `settings_save(settings)` | JSON at `app_config_dir()/settings.json` | missing file → defaults below |

Error classification (in `run.rs`, by stderr substring, case-insensitive): `not a git repository` → NotARepo; `permission denied (publickey)`, `authentication failed`, `could not read username` → Auth; the per-command rules above. Everything else → Other with the last non-empty stderr line as `message`.

Status parsing (`--porcelain=v2 -z`): records split by `\0`. `1 XY sub mH mI mW hH hI <path>`; `2 XY sub mH mI mW hH hI <Xscore> <path>` followed by one more `\0`-record = origPath; `u XY …10 fields… <path>`; `? <path>`; `! …` ignored. X = staged, Y = unstaged, `.` = none. Map `M`,`T` → M; `A` → A; `D` → D; `R`,`C` → R. Type 1/2: X ≠ `.` → staged entry, Y ≠ `.` → unstaged entry. `u` → unstaged `U`. `?` → unstaged `A` with `untracked: true`.

Numstat `-z` parsing: normal record `add\tdel\tpath\0`; rename record `add\tdel\t\0old\0new\0`; binary has `-\t-` → null.

Diff parsing: ignore lines before the first `@@`; any `Binary files … differ` → `binary: true`; hunk header `@@ -a[,b] +c[,d] @@…` sets counters; ` ` ctx (old++, new++), `+` add (new++), `-` del (old++), `\ No newline…` skipped.

Default settings: `{ repos: [], active: null, hideCi: false, ciPattern: "^AutoBuild$", jira: { P7, GARM, PILOTADM, RNTBST → "https://jira.pilot-gps.com/browse/"; NEWMFC, RPGU, SITCENTER → "https://jira.sccloud.ru/browse/"; VBV, MFCDEV, SDU → "https://atlassian.tatikoma.ru/jira/browse/" } }`. A Jira key in a subject is `^([A-Z][A-Z0-9]*)-(\d+)\b`; it becomes a link only when its prefix is in `jira`.

## Stages

### 1. Toolchain and scaffold
Rust toolchain, a Tauri 2 + React-TS skeleton inside the existing repo, test runners wired, prototype tokens ported.

- [ ] `brew install rustup` → `rustup-init -y --no-modify-path` (or `rustup default stable` if already initialised); `rustc --version` prints ≥ 1.80
- [ ] scaffold in the scratch dir: `pnpm create tauri-app gs-scaffold --template react-ts --manager pnpm --identifier dev.fosteev.gitsprout --yes`
- [ ] copy into the repo: `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `vite.config.ts`, `index.html`, `src/`, `src-tauri/`; keep the repo's `README.md`, `CLAUDE.md`, `.gitignore`, `prototype/`
- [ ] package name `gitsprout`; `src-tauri/tauri.conf.json`: productName `Gitsprout`, window title/size from "Context", identifier `dev.fosteev.gitsprout`
- [ ] add deps: `zustand`, `@tanstack/react-virtual`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`; dev: `vitest`; Rust: `serde`(derive), `serde_json`, `thiserror`, `tauri-plugin-dialog`, `tauri-plugin-opener`, dev `tempfile`; register both plugins and their capabilities in `src-tauri/capabilities/default.json`
- [ ] `package.json` scripts: `test` = `vitest run`; keep `build`, `tauri`
- [ ] create empty modules from the CLAUDE.md layout (`git/mod.rs`, `run.rs`, `parse.rs`, `ops.rs`, `commands.rs`, `settings.rs`) so later stages only fill them
- [ ] `src/styles/tokens.css`: the `:root` / light-theme token blocks copied verbatim from the prototype; Google Fonts replaced by bundled fallbacks (`Onest`, `JetBrains Mono` via `@fontsource/onest` and `@fontsource/jetbrains-mono`; `Unbounded` only for the wordmark via `@fontsource/unbounded`)
- [ ] `App.tsx` renders an empty window shell with the prototype's titlebar (logo + `gitsprout` wordmark) on `var(--bg)`
- [ ] one placeholder vitest test and one `#[test]` so both runners are proven

**Done when:** `pnpm install && pnpm build && pnpm test` and `cd src-tauri && cargo test && cargo clippy -- -D warnings` pass; `.gitignore` covers `node_modules/`, `dist/`, `src-tauri/target/`, `src-tauri/gen/`. `pnpm tauri dev` opening the window is checked by the user.

**Session:** sonnet, high; sequential (first).

### 2. Git core: read side
The runner, error type, pure parsers and every read command from the contract.

- [ ] `run.rs`: git binary resolution, `run(repo, args, stdin: Option<&str>, ok_codes: &[i32]) -> Result<String, GitError>`, env `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (read commands), `-c core.quotePath=false`, error classification
- [ ] `GitError`/`ErrorKind` with `Serialize`, implementing the JSON shape from the contract
- [ ] `parse.rs`: `parse_refs`, `parse_track`, `parse_log`, `parse_status`, `parse_name_status_z`, `parse_numstat_z`, `parse_diff`, `parse_stash_list` — each with unit tests on literal fixtures (rename, untracked, conflict `u`, binary, `gone` upstream, detached, body with blank lines, subject with `\x1f`-free unicode)
- [ ] `ops.rs` read functions + `commands.rs` wrappers (async + `spawn_blocking`) for: `repo_open`, `refs_list`, `log`, `status`, `diff_file`, `commit_files`, `diff_commit_file`, `stash_list`, `stash_files`, `stash_diff_file`; registered in `invoke_handler`
- [ ] `src-tauri/tests/read.rs`: builds a temp repo with the git CLI (two branches, a merge, a tag, a rename, an untracked file, a binary file, a stash) and asserts every read op

**Done when:** `cd src-tauri && cargo test && cargo clippy -- -D warnings` pass; manual: `cargo test -- --nocapture` of a debug test printing `refs_list` and `log(20)` for `/Users/fost/Projects/gitsprout` looks sane.

**Session:** sonnet, high; after stage 1.

### 3. Git core: write side and settings
Mutations, remote ops, settings persistence. Integration tests use a local bare repo as `origin`.

- [ ] `ops.rs` + `commands.rs`: `stage`, `unstage`, `stage_all`, `unstage_all`, `commit`, `checkout`, `checkout_remote`, `branch_create`, `branch_rename`, `branch_delete`, `fetch`, `pull`, `push`, `stash_push`, `stash_apply`, `stash_pop`, `stash_drop` exactly as in the contract
- [ ] `settings.rs`: `settings_load` / `settings_save` with the defaults from the contract
- [ ] `src-tauri/tests/write.rs` with a bare `origin` and two clones: stage/unstage/commit/amend; push without upstream sets `-u`; push rejected after the other clone pushes → `PushRejected`; pull fast-forward; pull with divergence → merge commit with two parents; pull conflict → `Conflict`; checkout_remote creates a tracking branch; branch_delete of an unmerged branch → `NotFullyMerged`, then `force` works; stash push/pop round trip with an untracked file; `stash_push` on a clean tree → `NothingToStash`; unstage in an unborn repo

**Done when:** `cd src-tauri && cargo test && cargo clippy -- -D warnings` pass.

**Session:** sonnet, high; after stage 2.

### 4. UI shell: tabs, toolbar, sidebar, store
The frame of the app with real data and no graph yet.

- [ ] `src/api/types.ts` (contract, verbatim) and `src/api/git.ts` (one typed wrapper per command; rejects with `GitError`)
- [ ] `src/state/store.ts` (zustand): settings, open repos, active repo, `refs`, `commits`, `status`, `stashes`, selection (`'WIP' | sha | 'stash:N'`), open diff, busy flags; `refresh()` loads refs+log+status+stashes in parallel; refresh on window focus (`getCurrentWindow().onFocusChanged`) and ⌘R
- [ ] repo tabs: open via `+` (dialog `open({ directory: true })` → `repo_open`), close tab, switch tab; persisted through `settings_save`; empty state when no repos ("Open a repository" button)
- [ ] toolbar from the prototype: repository/branch crumbs, Fetch/Pull/Push with behind/ahead badges for HEAD, Branch/Stash/Pop buttons (wired in stages 6–7; disabled for now)
- [ ] sidebar from the prototype: filter input (⌘⌥F), Local (folders by first `/` segment, check icon for HEAD, ↑/↓ badges, `gone` marker), Remote grouped by remote name, Stashes, Tags; collapsible sections keep their state
- [ ] status bar from the prototype (branch → upstream, ahead/behind, uncommitted count, stash count, remote URL)
- [ ] CSS for these parts ported from the prototype into `src/styles/` (same class names where possible)

**Done when:** `pnpm build && pnpm test` pass. User check: `pnpm tauri dev`, open Pilot7 and gitsprout as tabs, restart the app, both tabs come back, sidebar matches `git branch -vv`.

**Session:** sonnet, high; after stage 3.

### 5. Commit graph, commit details, diff view
The center pane and the read-only right panel.

- [ ] `src/graph/layout.ts`: port of prototype `layout()` and the per-row SVG geometry (`LANE = 14`, `RH = 30`), pure; WIP pseudo-row with the `~` dashed lane; hide-CI filtering by `settings.ciPattern` that rewrites parents to the nearest visible ancestor and never hides a commit that a ref points to
- [ ] `src/graph/layout.test.ts`: linear history, branch + merge, two lanes converging on one parent, WIP row, hidden CI commits, parent beyond the loaded set
- [ ] graph list virtualized with `@tanstack/react-virtual` (fixed 30 px rows), columns Branch/Tag · Graph · Message · Author · Date · SHA as in the prototype, responsive column hiding as in the prototype CSS
- [ ] message rendering: Jira chip (link via `plugin-opener` when the prefix is in `settings.jira`), `[ KIND ]` tag, muted merge/CI rows; search box dims non-matching rows (subject, sha prefix, author); "Hide AutoBuild" chip toggles and persists `hideCi`
- [ ] click selects, ↑/↓ and j/k move the selection; selecting a ref in the sidebar scrolls to its commit
- [ ] right panel for a commit: sha + copy, title, body, author, relative date, parents (clickable), refs, Jira link, files via `commit_files` with +/−; merge commits show the prototype's merge note
- [ ] diff view replaces the graph (as in the prototype) with a back button and Esc; line numbers, hunk headers, binary note, "truncated" note

**Done when:** `pnpm build && pnpm test` pass. User check on Pilot7: the graph matches `git log --graph --oneline -50` in shape, scrolling 1000 commits stays smooth, AutoBuild hiding works.

**Session:** sonnet, high; after stage 4.

### 6. Working tree and commit
Everything around `// WIP`.

- [ ] WIP row on top of the graph when `status` is non-empty, selected by default after opening a dirty repo
- [ ] right panel WIP mode: Unstaged/Staged lists with per-file Stage/Unstage and Stage all/Unstage all; click opens `diff_file` with the right area (`untracked` for untracked files); diff header has Stage/Unstage file
- [ ] commit box: summary with 72-char countdown, description, Amend (prefills summary/body of HEAD), buttons "Commit N files" and "Commit & push", ⌘↵, hint line; draft survives re-renders and refreshes
- [ ] after commit: toast `Committed <sha> on <branch>`; amend of an already-pushed commit shows the prototype's warning toast
- [ ] toast component (ok/warn/bad, auto-dismiss as in the prototype) and a `showError(GitError)` mapping each `ErrorKind` to the prototype's wording (PushRejected: "Push rejected: … Pull first, then push.")

**Done when:** `pnpm build && pnpm test` pass. User check: stage two files of three, commit, amend, Commit & push on a scratch branch of the gitsprout repo.

**Session:** sonnet, high; after stage 5.

### 7. Branches, remotes, stash, menus
The rest of the toolbar and the context menus.

- [ ] Fetch / Pull / Push wired with busy state (button spinner, no double-run), toasts as in the prototype; Push without upstream publishes and sets upstream
- [ ] checkout: double-click local branch; double-click remote → `checkout_remote`; Enter on a focused ref; `LocalChanges` error shown as a toast
- [ ] modal component (prototype `openModal`): create branch (from HEAD or from a commit/ref, "Check out after creating"), rename, delete (with unpushed warning; on `NotFullyMerged` offer "Delete anyway" → `force`), drop stash
- [ ] context menus exactly as in the prototype `menuFor()` for local / remote / stash / commit; "later" items stay disabled
- [ ] stash: toolbar Stash/Pop, stash panel (files via `stash_files`, diff via `stash_diff_file`, Apply/Pop/Drop)
- [ ] copy SHA / branch name / message via `navigator.clipboard`

**Done when:** `pnpm build && pnpm test` pass. User check in a scratch clone: the prototype scenario (commit on a behind branch → push rejected → pull merges → push passes), stash with an untracked file and pop it back.

**Session:** sonnet, high; after stage 6.

### 8. Package and dogfood
A real `.app` the user can keep in /Applications.

- [ ] `app-icon.svg` (the prototype sprout logo on a rounded square, leaf-green on dark) → 1024 PNG via `npx @resvg/resvg-js-cli` → `pnpm tauri icon app-icon.png`
- [ ] `pnpm tauri build` produces `Gitsprout.app` and `.dmg` (unsigned); README gets "Build & run" (incl. right-click → Open for the unsigned app)
- [ ] perf check: time of `refresh()` on Pilot7 printed to the dev console; target < 500 ms for 1000 commits; note the number in the report
- [ ] README: remove "(planned)" from the stack, list keyboard shortcuts

**Done when:** `pnpm tauri build` succeeds and the `.app` path is in the report. User check: a full working day on Pilot7 without opening GitKraken; findings go to a new roadmap.

**Session:** sonnet, high; after stage 7.

## Session prompts

All prompts follow one shape. To launch stage N: `Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: true, prompt: "Read the prompt in /Users/fost/Projects/gitsprout/roadmap-mvp.md, section 'Session prompts → Stage N', and follow it literally. Your last message is the report described there.")`.

### Stage 1

```
Session 1 — Gitsprout toolchain and scaffold · Model: sonnet, effort: high · first session

Work in /Users/fost/Projects/gitsprout (git repo, branch main; contains README.md, CLAUDE.md, .gitignore, prototype/, roadmap-mvp.md). Task: install Rust and scaffold a Tauri 2 + React-TS app inside this repo, per stage 1 of roadmap-mvp.md.

Read: roadmap-mvp.md sections "Context and constraints" and "1. Toolchain and scaffold"; CLAUDE.md. From prototype/gitsprout.html read only the <style> :root/light token blocks and the titlebar markup (grep for ':root' and 'class="titlebar"').
Scratch dir for the scaffold: /private/tmp/claude-501/-Users-fost-Projects/a274c04c-4256-432c-b506-c1361f92c7d7/scratchpad (or $TMPDIR if that is gone).

Already decided, don't ask: stack and deps listed in the roadmap; identifier dev.fosteev.gitsprout; pnpm; fonts via @fontsource packages; macOS only.

Order: follow the stage 1 checkboxes top to bottom; tick each in roadmap-mvp.md only after verifying it.
If a create-tauri-app flag is rejected, run it with --help and use the equivalent; note it in the report.

DoD: pnpm install && pnpm build && pnpm test pass; cd src-tauri && cargo test && cargo clippy -- -D warnings pass.
Long output goes to a log file; show only tails and error lines.

Don't: write git logic (stages 2–3); add libraries not in the roadmap; touch prototype/; run `pnpm tauri dev` in the background and leave it running.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 2

```
Session 2 — Gitsprout git core, read side · Model: sonnet, effort: high · after session 1

Work in /Users/fost/Projects/gitsprout. Task: implement the git runner, parsers and all read commands per stage 2 of roadmap-mvp.md. The Tauri skeleton and empty modules in src-tauri/src/git/ exist from stage 1.

Read: roadmap-mvp.md sections "Context and constraints", "Command contract (Rust ↔ TS)" (all of it — it is the spec), "2. Git core: read side"; CLAUDE.md.
Entry points: src-tauri/src/lib.rs (invoke_handler registration), src-tauri/src/git/{run,parse,ops}.rs, src-tauri/src/commands.rs.

Already decided, don't ask: exact git invocations, parsing rules, error kinds, JSON field names (camelCase) — all in the contract. No git2 crate. Commands are async + tauri::async_runtime::spawn_blocking.

Order: run.rs + GitError → parse.rs with unit tests → ops.rs read functions → commands.rs + registration → tests/read.rs integration test on a temp repo built with the git CLI. Tick roadmap checkboxes after verifying.

DoD: cd src-tauri && cargo test && cargo clippy -- -D warnings pass. Long output to a log; show tails and error lines.

Don't: implement write commands (stage 3); touch src/ (frontend); change the contract — if it is wrong or incomplete, follow it as close as possible and put the issue in the report.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 3

```
Session 3 — Gitsprout git core, write side and settings · Model: sonnet, effort: high · after session 2

Work in /Users/fost/Projects/gitsprout. Task: implement all write commands, remote ops and settings per stage 3 of roadmap-mvp.md. run.rs, parse.rs, read ops and tests/read.rs exist from stage 2 — reuse run() and the error classification, open only what you edit.

Read: roadmap-mvp.md sections "Command contract (Rust ↔ TS)" and "3. Git core: write side and settings"; CLAUDE.md.
Entry points: src-tauri/src/git/ops.rs, src-tauri/src/commands.rs, src-tauri/src/settings.rs, src-tauri/src/lib.rs. Pattern to copy: the read commands from stage 2 and tests/read.rs for temp-repo helpers.

Already decided, don't ask: pull = `pull --no-rebase --no-edit`; push without upstream = `push -u <first remote> HEAD`; settings path app_config_dir()/settings.json with the contract defaults; error mapping per contract.

Order: follow the stage 3 checkboxes; tests/write.rs uses a local bare repo as origin and two clones (set user.name/user.email in each temp repo). Tick checkboxes after verifying.

DoD: cd src-tauri && cargo test && cargo clippy -- -D warnings pass. Long output to a log; show tails and error lines.

Don't: touch src/ (frontend); hit any real remote; add a file watcher.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 4

```
Session 4 — Gitsprout UI shell · Model: sonnet, effort: high · after session 3

Work in /Users/fost/Projects/gitsprout. Task: build the app frame with real data — repo tabs, toolbar, sidebar, status bar, store — per stage 4 of roadmap-mvp.md. All Rust commands exist (stages 2–3); src/ is the stage 1 skeleton.

Read: roadmap-mvp.md sections "Command contract (Rust ↔ TS)" and "4. UI shell"; CLAUDE.md. Visual and behavioural reference: prototype/gitsprout.html — read its CSS for .titlebar/.tabs/.toolbar/.side/.ref/.status and the renderSide()/renderChrome() functions; copy class names, spacing and copy text.
Entry points: src/App.tsx, src/styles/tokens.css, src-tauri/capabilities/default.json (dialog permission).

Already decided, don't ask: zustand store; types.ts mirrors the contract verbatim; refresh after mutations, on focus and ⌘R, no watcher; tabs persisted through settings_save; graph area is a placeholder in this stage.

Order: follow the stage 4 checkboxes; tick after verifying.

DoD: pnpm build && pnpm test pass. Long output to a log; show tails and error lines.

Don't: build the graph or the right panel (stages 5–6); wire Pull/Push/Stash actions (stage 7); change Rust code except capabilities.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 5

```
Session 5 — Gitsprout commit graph and diff view · Model: sonnet, effort: high · after session 4

Work in /Users/fost/Projects/gitsprout. Task: the commit graph, commit details panel and diff view per stage 5 of roadmap-mvp.md. The store, api wrappers and shell exist from stage 4.

Read: roadmap-mvp.md section "5. Commit graph, commit details, diff view"; CLAUDE.md. Reference: prototype/gitsprout.html functions visibleRows(), layout(), rowSvg(), msgHtml(), pills(), renderGraph(), renderPanel() (commit branch), renderDiff(), and the CSS for .row/.gcols/.pill/.msg/.dl/.meta. Port the layout algorithm as-is; it is already validated.
Entry points: src/state/store.ts, src/api/git.ts, the placeholder graph area in the shell.

Already decided, don't ask: LANE=14, RH=30; @tanstack/react-virtual with fixed row height; Jira links via @tauri-apps/plugin-opener using settings.jira; hide-CI by settings.ciPattern, never hiding ref tips.

Order: layout.ts + layout.test.ts first, then the graph component, then the panel, then the diff view. Tick roadmap checkboxes after verifying.

DoD: pnpm build && pnpm test pass. Long output to a log; show tails and error lines.

Don't: WIP staging or commit box (stage 6); context menus or modals (stage 7); Rust changes.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 6

```
Session 6 — Gitsprout working tree and commit · Model: sonnet, effort: high · after session 5

Work in /Users/fost/Projects/gitsprout. Task: WIP row, staging panel, commit box, toasts and error mapping per stage 6 of roadmap-mvp.md. Graph, panel and diff view exist from stage 5.

Read: roadmap-mvp.md section "6. Working tree and commit"; CLAUDE.md. Reference: prototype/gitsprout.html renderPanel() (WIP branch), fileRow(), syncCommitButtons(), doCommit(), toast(), the submit/keydown handlers and CSS for .psec/.file/.commitbox/.toast.
Entry points: src/state/store.ts, the right-panel component and diff view from stage 5.

Already decided, don't ask: draft lives in the store (survives refresh); amend prefills summary and body from HEAD; error wording copies the prototype toasts.

Order: follow the stage 6 checkboxes; tick after verifying.

DoD: pnpm build && pnpm test pass. Long output to a log; show tails and error lines.

Don't: fetch/pull/push buttons, checkout, branch modals, stash (stage 7); Rust changes.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 7

```
Session 7 — Gitsprout branches, remotes, stash, menus · Model: sonnet, effort: high · after session 6

Work in /Users/fost/Projects/gitsprout. Task: wire Fetch/Pull/Push, checkout, branch create/rename/delete, stash and context menus per stage 7 of roadmap-mvp.md. Toasts and showError exist from stage 6.

Read: roadmap-mvp.md section "7. Branches, remotes, stash, menus"; CLAUDE.md. Reference: prototype/gitsprout.html pull(), push(), fetchAll(), checkout(), checkoutRemote(), createBranchModal(), openModal(), showMenu(), menuFor(), act() cases rename/delete/stash-*, and CSS for .ctx/.scrim/.modal.
Entry points: src/state/store.ts, toolbar and sidebar components from stage 4, right panel from stages 5–6.

Already decided, don't ask: menus exactly as menuFor(); "later" items disabled; NotFullyMerged → offer "Delete anyway" (force); busy flag per remote op blocks double runs.

Order: follow the stage 7 checkboxes; tick after verifying.

DoD: pnpm build && pnpm test pass. Long output to a log; show tails and error lines.

Don't: reset/revert/cherry-pick (post-MVP); Rust changes unless a contract bug blocks you — then describe it in the report instead.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 8

```
Session 8 — Gitsprout packaging · Model: sonnet, effort: high · after session 7

Work in /Users/fost/Projects/gitsprout. Task: app icon, release build, README update, perf measurement per stage 8 of roadmap-mvp.md.

Read: roadmap-mvp.md section "8. Package and dogfood"; CLAUDE.md; README.md. Logo source: the <svg> inside .brand in prototype/gitsprout.html.

Already decided, don't ask: unsigned build; icon via @resvg/resvg-js-cli + `pnpm tauri icon`; README in English.

Order: follow the stage 8 checkboxes; tick after verifying.

DoD: `pnpm tauri build` succeeds; report contains the .app and .dmg paths and the measured refresh time. Long output to a log; show tails and error lines.

Don't: code signing or notarization; new features.
Don't commit or push — acceptance does that.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

## Risks and open questions

- **SSH from a GUI app.** Finder-launched apps inherit `SSH_AUTH_SOCK` from launchd, so agent keys should work; a key with a passphrase that is not in the agent will fail with `Auth` instead of prompting. Found in stage 7 user check; fix post-MVP with `SSH_ASKPASS` if it bites.
- **HTTPS remotes** without a credential helper fail fast because of `GIT_TERMINAL_PROMPT=0`. The user's remotes are SSH, so this is accepted.
- **VPN (Wayfork)** may slow fetch/push to gitlab.pilot-gps.com; ops are async, so the UI stays responsive.
- **Big repos.** `refresh()` runs four git processes; if Pilot7 is above 500 ms, cache `log` and refetch it only after ref changes (post-MVP).
- **create-tauri-app flags** are an assumption (see Context); stage 1 falls back to `--help`.
- Open for the user: nothing blocking. Signing/notarization, a file watcher, Windows/Linux, rebase/cherry-pick/revert are post-MVP.

## Order of work

All stages run sequentially: one repo, and each stage builds on the previous one's files. 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Each stage ends with `/plan-review` (Opus): check against this file, fix or document deviations, run the stage's "Done when" commands, commit and push to `main`. User checks listed under "Done when" pile up in the acceptance report and don't block the next stage unless they fail.
