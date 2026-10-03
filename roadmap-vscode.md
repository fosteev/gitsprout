# Gitsprout VS Code extension — MVP

> Status: stage 1 accepted 2026-10-03 · next — stage 2 · created 2026-10-03 · executors tick checkboxes as each step is verified, not when it "should work". Start with stage 1.

## Goal

A `.vsix` the user installs in VS Code and Cursor that replaces GitKraken for daily work in `~/Projects` (≈40 repos under `at/`, `pilot/`, `tatikoma/`, some nested one level deeper) and in single-repo windows: repository overview, branch/remote/stash/tag trees, commit graph, native diffs, fetch/pull/push, stash. Staging and committing stay in the built-in Source Control.

## Context and constraints

- Scope: `README.md`. Repo rules and layout: `CLAUDE.md`.
- Behaviour/copy reference: `prototype/vscode-multi.html` (multi-repo) and `prototype/vscode.html` (single repo). Port from them: lane layout `layout()` + `rowSvg()` geometry, `visibleRows()` CI hiding, `msgHtml()` (Jira chip + `[ KIND ]` tag), graph columns, details card, notification/quick-pick wording. Everything the prototype *emulates* (tree views, quick pick, input box, modal dialog, notifications, context menus, diff editor, SCM) is native VS Code API in the extension.
- Toolchain (checked 2026-10-03): node 22.23, pnpm 9.0, git 2.49. VS Code and Cursor on the user's Mac.
- Pivot (2026-10-03): the Tauri desktop app was dropped. Its plan is `docs/archive/roadmap-tauri.md`; its git invocation/parsing rules carry over below.

### Decisions (don't revisit without the user)

| Topic | Decision |
|---|---|
| Engine | `engines.vscode: "^1.90.0"` (Cursor compatible), `main: dist/extension.js`, activation `onStartupFinished` + `workspaceContains:**/.git` |
| Build | esbuild script `scripts/build.mjs`: extension bundle (node, cjs, external `vscode`) + webview bundle (browser, iife) → `dist/`; `pnpm watch` for F5 |
| Webview UI | plain TypeScript, string templates ported from the prototype, no framework; manual windowing (fixed 26 px rows) |
| Git access | own runner over the system `git` (`execFile`, no shell); not the built-in `vscode.git` API. Git path: setting `git.path` if set, else `git` |
| Staging/commit | not implemented; WIP row offers "Open Source Control" (`workbench.view.scm`) |
| Diffs | own `TextDocumentContentProvider`, scheme `gitsprout`, + `vscode.diff`. Untracked files open as a normal document |
| Context menus in the graph | native `webview/context` menus via `data-vscode-context` |
| Repo discovery | own scan of workspace folders, depth `gitsprout.scanDepth` (default 3); stop descending once a repo is found (nested repos ignored); skip `node_modules`, `vendor`, dot-dirs, symlinks; `.git` *file* pointing into `/modules/` (submodule) is skipped |
| Repo summary | one `git status --porcelain=v2 --branch -z` per repo (branch, upstream, ahead/behind, change count) |
| Refresh | per-repo `FileSystemWatcher` on `.git/{HEAD,index,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**}` debounced 300 ms + window focus + after every Gitsprout mutation |
| Pull | `git pull --no-rebase --no-edit` (fast-forward when possible, merge when diverged — matches the user's history) |
| Auth failures | `GIT_TERMINAL_PROMPT=0`; on `Auth` error offer "Run in Terminal" (integrated terminal with `cwd` = repo, same git command) |
| Built-in SCM depth | if the workspace has repos deeper than `git.repositoryScanMaxDepth` (default 1), show once: "Source Control sees N of M repositories" with "Set depth to K" (writes workspace setting) / "Don't ask again" |
| Package | `@vscode/vsce package --no-dependencies` (bundled, pnpm-safe); no marketplace publishing in MVP |

## Contract

### Types (`src/git/types.ts`)

```ts
export type ErrorKind = 'NotARepo' | 'GitMissing' | 'PushRejected' | 'NoUpstream' | 'Conflict'
  | 'LocalChanges' | 'NotFullyMerged' | 'Auth' | 'NothingToStash' | 'Other';
export class GitError extends Error { constructor(public kind: ErrorKind, message: string, public stderr: string, public args: string[]) { super(message); } }

export interface RepoSummary { root: string; name: string; relPath: string; group: string;  // group = first segment of relPath ('' for a top-level repo)
  branch: string | null; sha: string | null; upstream: string | null; ahead: number; behind: number; changes: number; }
export interface Head { branch: string | null; sha: string | null }               // branch null = detached, sha null = unborn
export interface LocalBranch { name: string; sha: string; upstream: string | null; ahead: number; behind: number; upstreamGone: boolean }
export interface RemoteBranch { name: string; sha: string }                        // "origin/develop"
export interface Tag { name: string; sha: string }                                 // peeled commit sha
export interface Refs { head: Head; locals: LocalBranch[]; remotes: RemoteBranch[]; tags: Tag[] }
export interface Commit { sha: string; parents: string[]; author: string; email: string; time: number; subject: string; body: string }
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
export interface FileChange { path: string; origPath: string | null; status: FileStatus; untracked: boolean }
export interface Status { staged: FileChange[]; unstaged: FileChange[] }
export interface FileStat { path: string; origPath: string | null; status: FileStatus; add: number | null; del: number | null }
export interface Stash { index: number; sha: string; message: string }
```

### Git invocations (`src/git/repo.ts`, always `git -C <root>` via `run.ts`)

| Method | Invocation | Notes |
|---|---|---|
| `summary()` | `status --porcelain=v2 --branch -z --untracked-files=all` | headers `# branch.oid` (`(initial)` = unborn), `# branch.head` (`(detached)`), `# branch.upstream`, `# branch.ab +A -B`; `changes` = number of entry records |
| `refs()` | `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(*objectname) refs/heads refs/remotes refs/tags` + `symbolic-ref -q --short HEAD` (exit 1 = detached) + `rev-parse -q --verify HEAD` | skip `refs/remotes/*/HEAD`; track text `ahead N, behind M` / `ahead N` / `behind M` / `gone` / empty |
| `log(limit)` | `log --branches --remotes --tags HEAD --topo-order -n <limit> -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b` | drop `HEAD` when unborn; records split by `\0`, fields by `\x1f` |
| `status()` | `status --porcelain=v2 -z --untracked-files=all` | rules below |
| `commitFiles(sha)` | `diff-tree -r --root --no-commit-id -M -z --name-status <sha>` + same with `--numstat` | merges → `[]` |
| `stashes()` | `stash list -z --format=%gd%x1f%H%x1f%gs` | |
| `stashFiles(i)` | `stash show --name-status -z --include-untracked stash@{i}` | add/del null; mark files that exist only in `stash@{i}^3` as untracked (`rev-parse -q --verify stash@{i}^3`, then `ls-tree -r --name-only -z stash@{i}^3`) |
| `show(ref, path)` | `show <ref>:<path>` | content for the diff provider; missing → empty string |
| `checkout(name)` | `switch <name>` | "would be overwritten" → LocalChanges |
| `checkoutRemote(r)` | local = text after first `/`; exists → `switch <local>`, else `switch --track <r>` | |
| `createBranch(name, start, checkout)` | `check-ref-format --branch <name>`, then `branch <name> <start>` or `switch -c <name> <start>` | |
| `renameBranch(old, new)` | `branch -m <old> <new>` | |
| `deleteBranch(name, force)` | `branch -d|-D <name>` | "not fully merged" → NotFullyMerged |
| `fetch()` | `fetch --all --prune` | |
| `pull()` | no upstream → NoUpstream; `pull --no-rebase --no-edit` | `CONFLICT` / `Automatic merge failed` → Conflict |
| `push()` | upstream → `push`; else `push -u <first remote> HEAD` | `[rejected]`, `non-fast-forward`, `fetch first` → PushRejected |
| `stashPush(msg?)` | `stash push -u [-m <msg>]` | "No local changes to save" → NothingToStash |
| `stashApply/Pop/Drop(i)` | `stash apply|pop|drop stash@{i}` | conflict → Conflict |

Error classification in `run.ts` (stderr, case-insensitive): `not a git repository` → NotARepo; `ENOENT` spawn → GitMissing; `permission denied (publickey)`, `authentication failed`, `could not read username` → Auth; per-method rules above; else Other with the last non-empty stderr line.

Status `-z` parsing: `1 XY sub mH mI mW hH hI <path>`; `2 XY sub mH mI mW hH hI <Xscore> <path>` + next record = origPath; `u XY` (10 fields) `<path>`; `? <path>`; `!` ignored; `#` headers. X = staged, Y = unstaged, `.` = none; `M`,`T`→M, `A`→A, `D`→D, `R`,`C`→R; type 1/2 → staged if X≠`.`, unstaged if Y≠`.`; `u` → unstaged U; `?` → unstaged A with `untracked: true`.
Numstat `-z`: `add\tdel\tpath\0`, rename `add\tdel\t\0old\0new\0`, binary `-\t-` → null.

### Diff URIs (`src/diff/provider.ts`)

`gitsprout:/<path>?<query>` where query = `encodeURIComponent(JSON.stringify({ root, ref, path }))`; `ref` is a git rev (`<sha>`, `<sha>^`, `:` for the index, `stash@{0}^1`, …) or `""` for an empty side. `openDiff(left, right, title)` calls `vscode.diff`. Titles copy the prototype: `push_daemon.php (Working Tree)`, `(Index)`, `(06da7e4 ↔ bb3c907)`, `(stash@{0})`.

| Source | Left | Right |
|---|---|---|
| commit file (A/M/D/R) | `<sha>^:<origPath or path>` (empty for A or root commit) | `<sha>:<path>` (empty for D) |
| unstaged file | `:<path>` (index) | file URI |
| staged file | `HEAD:<origPath or path>` (empty when unborn or A) | `:<path>` |
| untracked file | — | `vscode.open` file URI |
| stash file | `stash@{i}^1:<path>` (empty if untracked) | `stash@{i}:<path>`, or `stash@{i}^3:<path>` if untracked |

### Webview protocol (`src/graph/protocol.ts`)

```ts
export type ToWebview =
  | { type: 'state'; repo: { root: string; name: string }; head: Head; commits: Commit[]; refs: Refs; wip: Status | null; settings: { ciPattern: string; hideCi: boolean; jira: Record<string, string> } }
  | { type: 'details'; sha: string; files: FileStat[] }
  | { type: 'reveal'; sha: string }                      // select + scroll (from tree views)
  | { type: 'busy'; on: boolean };
export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; sha: string }                      // extension answers with 'details'
  | { type: 'openCommitFile'; sha: string; file: FileStat }
  | { type: 'openWipFile'; file: FileChange; area: 'staged' | 'unstaged' }
  | { type: 'openScm' } | { type: 'switchRepo' } | { type: 'refresh' }
  | { type: 'toggleCi'; hideCi: boolean }
  | { type: 'openUrl'; url: string };
```
Rows carry `data-vscode-context='{"webviewSection":"commit","sha":"…","preventDefaultContextMenuItems":true}'`.

### Manifest contributions (`package.json`)

- `viewsContainers.activitybar`: `gitsprout` (title "Gitsprout", icon `media/sprout.svg`, monochrome).
- `views.gitsprout`: `gitsprout.repositories` ("Repositories", `when: gitsprout.multiRepo`), `gitsprout.branches`, `gitsprout.remotes`, `gitsprout.stashes`, `gitsprout.tags`.
- Commands (`category: "Gitsprout"`): `showGraph`, `switchRepository`, `refresh`, `fetch`, `fetchAll`, `pull`, `push`, `checkout` (quick pick), `checkoutBranch`, `checkoutRemote`, `createBranch`, `createBranchFrom`, `renameBranch`, `deleteBranch`, `stash`, `stashApply`, `stashPop`, `stashDrop`, `copySha`, `copyMessage`, `copyBranchName`, `copyRepoPath`, `toggleAutoBuild`, `toggleOnlyAttention`, `openSourceControl`, `repoShowGraph`, `repoFetch` — all ids prefixed `gitsprout.`.
- Menus: `view/title` (fetch, pull, push, show graph on branches; fetch all + attention filter on repositories; stash on stashes), `view/item/context` by `contextValue` (`repo`, `branch.local`, `branch.local.head`, `branch.remote`, `stash`, `stashFile`, `tag`) with `inline` groups as in the prototype, `webview/context` (`webviewId == 'gitsprout.graph' && webviewSection == 'commit'`: Create Branch Here…, Copy Commit SHA, Copy Commit Message).
- Keybindings: `gitsprout.showGraph` ⌥⌘G, `gitsprout.switchRepository` ⌥⌘R.
- Settings: `gitsprout.scanDepth` (3), `gitsprout.scanExclude` (`["**/node_modules","**/vendor"]`), `gitsprout.logLimit` (1000), `gitsprout.ciPattern` (`"^AutoBuild$"`), `gitsprout.hideCi` (false), `gitsprout.followActiveEditor` (true), `gitsprout.fetchConcurrency` (4), `gitsprout.jira` (object; defaults P7, GARM, PILOTADM, RNTBST → `https://jira.pilot-gps.com/browse/`; NEWMFC, RPGU, SITCENTER → `https://jira.sccloud.ru/browse/`; VBV, MFCDEV, SDU → `https://atlassian.tatikoma.ru/jira/browse/`).

## Stages

### 1. Scaffold
An installable extension that shows the sprout container with empty views.

- [x] `package.json`: name `gitsprout`, displayName `Gitsprout`, publisher `fosteev`, version `0.1.0`, engines, activation events, `main`, all contributions from "Manifest contributions" (commands may be stubs that show "Not implemented yet")
- [x] dev deps: `typescript`, `esbuild`, `@types/vscode@~1.90.0`, `@types/node@20`, `vitest`, `@vscode/vsce`; scripts `build`, `watch`, `typecheck`, `test`, `package` as in `CLAUDE.md`
- [x] `tsconfig.json` (extension, `module: commonjs`, `strict`) and `webview/tsconfig.json` (DOM lib); `scripts/build.mjs` builds both bundles
- [x] `media/sprout.svg` (monochrome, `currentColor`, from the prototype logo) and `media/icon.png` 128×128 (rendered with `npx @resvg/resvg-js-cli`)
- [x] `.vscode/launch.json` "Run Extension" + `.vscode/tasks.json` (`pnpm watch`); `.vscodeignore` ships only `dist/`, `media/`, `package.json`, `README.md`, `LICENSE` if any
- [x] `src/extension.ts` registers stub commands and empty tree providers; one placeholder vitest test
- [x] `.gitignore`: `node_modules/`, `dist/`, `*.vsix`, `.vscode-test/`

**Done when:** `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm package` pass and produce `gitsprout-0.1.0.vsix`. User check: F5 → sprout icon in the Activity Bar with five empty views (Repositories only in a multi-root folder later).

**Session:** sonnet, high; first.

**Decisions (2026-10-03, session 1):**
- Layout: `src/extension.ts` (wiring), `src/commands/ids.ts` (command/view id lists, no `vscode` import), `src/commands/stubs.ts` (stub commands showing "Gitsprout: not implemented yet."), `src/views/emptyTree.ts` (empty `TreeDataProvider` for all five views), `webview/main.ts` (empty entry so the webview bundle builds), `vitest.config.mts` (`test/**/*.test.ts`; `.mts` so Vite loads it as ESM without a warning), `test/placeholder.test.ts` + `test/manifest.test.ts` (manifest <-> `ids.ts` consistency, menus/keybindings reference declared commands).
- `gitsprout.multiRepo` is set to `false` in `activate()`, so Repositories stays hidden until stage 3 flips it.
- `.gitignore`: dropped `.vscode/` (launch/tasks must be committed) and the obsolete `src-tauri/gen/`; added `.serena/`.
- Toolchain: typescript ^7.0.2 (npm `latest`, the native port), esbuild 0.28, vitest ^4.1, vsce 4.0, `@types/node` 20, `@types/vscode` ~1.90.0. TS 7 rejects `moduleResolution: node10`, so `tsconfig.json` omits it (`module: commonjs`); tests use `__dirname`, not `import.meta`.
- Review (2026-10-03): TS 7 kept — `tsc` is only the type checker here; esbuild and vitest transpile on their own and nothing consumes the TS JS API (no eslint/ts-node/ts-jest). If a tool later needs the TS 5 API, pin `typescript@~5.9` and set `moduleResolution: bundler`. Vitest moved 5.0 → 4.1: vitest 5 requires `@types/node` ^22 || >=24, vitest 4.1 accepts ^20, and `@types/node@20` stays because VS Code 1.90 runs Node 20 (no Node 22 APIs in `src/`).
- `.vscodeignore` ships `dist/*.js` (no source maps), `media/`, `package.json`, `README.md`, `LICENSE`. `.vsix` has 8 files, 9.1 KB.
- `media/icon.png` is the prototype sprout in white on a green (#2e7d32) rounded square, rendered with `@resvg/resvg-js-cli` from a temp SVG (not kept in the repo); the colour is a placeholder choice.
- Menus: command-to-`contextValue` assignments and `inline`/group names beyond the roadmap text are my guess (inline: fetch/graph on repo, checkout on branches, apply/pop/drop on stash); stage 4/6 should refine them against the prototype. Keybindings: `mac` `alt+cmd+g` / `alt+cmd+r`, `key` `ctrl+alt+g` / `ctrl+alt+r` elsewhere (review fix: `cmd` doesn't exist off macOS).
- `pnpm package` warns about missing `repository` and `LICENSE`; left as is (`license: UNLICENSED`, `private: true`).
- `pnpm watch` prints `[watch] <bundle> build started|finished` from an esbuild plugin; `.vscode/tasks.json` waits for the extension bundle's "finished" line, so F5 never launches before `dist/extension.js` exists (review fix: the old `watching…` line was printed before the first build ended).
- Review note: `workspaceContains:**/.git` most likely never fires (VS Code's glob search lists files, not the `.git` directory); harmless because `onStartupFinished` activates anyway. Kept as decided.
- Not verified: F5 / Extension Development Host, sprout icon rendering in the Activity Bar, five empty views, `.vscode/launch.json` + `tasks.json` actually working (user check).

### 2. Git layer
Runner, parsers, read and write operations, tested without VS Code.

- [ ] `src/git/run.ts`: `run(root, args, { stdin?, okCodes?, read? })` with env and error classification from the contract; `git.path` passed in by the caller (no `vscode` import in `src/git/`)
- [ ] `src/git/parse.ts`: `parseStatusSummary`, `parseStatus`, `parseRefs`, `parseTrack`, `parseLog`, `parseNameStatusZ`, `parseNumstatZ`, `parseStashList` with unit tests (`test/parse.test.ts`): rename, untracked, conflict `u`, binary numstat, `gone`, detached, unborn `(initial)`, body with blank lines
- [ ] `src/git/repo.ts`: class `Repo(root, gitPath)` with every method from the invocation table
- [ ] `test/repo.integration.test.ts`: temp repos via git CLI (`user.name`/`user.email` set per repo), a bare `origin` and two clones: summary/refs/log/status/commitFiles/stashes; push without upstream sets `-u`; push rejected → PushRejected; pull fast-forward; pull diverged → merge commit with 2 parents; pull conflict → Conflict; checkoutRemote creates tracking branch; deleteBranch unmerged → NotFullyMerged, then force; stash push/pop with an untracked file; clean tree stash → NothingToStash

**Done when:** `pnpm typecheck && pnpm test` pass.

**Session:** sonnet, high; after 1.

### 3. Workspace, repositories view, status bar
Discovery, the repo registry and everything that is multi-repo.

- [ ] `src/workspace/discovery.ts`: `discover(folders, depth, exclude)` per "Decisions"; unit test on a temp dir tree (nested folders, a nested repo, a submodule `.git` file, `node_modules`)
- [ ] `src/workspace/registry.ts`: repos + summaries (concurrency 8 on activation), `activeRepo` (initial: repo of the active editor, else the first), events `onDidChangeRepos` / `onDidChangeActive` / `onDidChangeRepo(root)`, watchers + debounce, refresh on focus, follow active editor (`gitsprout.followActiveEditor`), context key `gitsprout.multiRepo`
- [ ] `src/views/repositories.ts`: tree grouped by `group` and sub-folders (prototype `reposPane()`), description `branch* N↓ M↑`, change count, `contextValue: repo`, inline Fetch / Show Graph, click → set active repo; "needs attention" filter (`toggleOnlyAttention`, title shows `39 · 7 need attention`)
- [ ] `switchRepository` quick pick grouped by folder (prototype `qp-repo`); status bar item `$(gitsprout-icon or repo) <name>` → switchRepository (single repo: "Gitsprout" → showGraph)
- [ ] built-in SCM depth check from "Decisions"
- [ ] `fetchAll` with `withProgress` (cancellable, `gitsprout.fetchConcurrency`), summary notification listing repos with incoming commits + "Show Only These"; `repoFetch` for one repo

**Done when:** `pnpm typecheck && pnpm test` pass. User check: open `~/Projects` → Repositories shows 39 repos grouped by at/pilot/tatikoma, the filter leaves the dirty/diverged ones, switching follows editor tabs, Fetch All reports incoming commits.

**Session:** sonnet, high; after 2.

### 4. Ref views and native diffs
The four trees for the active repo plus the diff provider.

- [ ] `src/views/branches.ts`: locals grouped by first `/` segment, HEAD with `$(check)`, description `N↓ M↑` / `gone` / `local only`, `contextValue` `branch.local(.head)`, inline Checkout (non-HEAD) or Pull/Push (HEAD); click → reveal commit in the graph (if open)
- [ ] `src/views/remotes.ts` (grouped by remote, inline "Checkout as local branch"), `src/views/stashes.ts` (expandable to files, inline Apply/Pop/Drop, file click → stash diff), `src/views/tags.ts`
- [ ] titles follow the active repo (`TreeView.description = repo name` in multi-repo)
- [ ] `src/diff/provider.ts` + `openDiff` helpers for every row of the "Diff URIs" table; unit test for URI encode/decode and title building

Note (stage 1 review): the stage 1 `view/item/context` menus are placeholders — add inline Pull/Push for `branch.local.head` and a `stashFile` entry here, against the prototype.

**Done when:** `pnpm typecheck && pnpm test` pass. User check: trees match `git branch -vv`, `git stash list`, `git tag`; a stash file opens a side-by-side diff.

**Session:** sonnet, high; after 3.

### 5. Commit graph webview
The graph tab, ported from the prototype, talking the protocol.

- [ ] `src/graph/panel.ts`: single `WebviewPanel` (`viewType: gitsprout.graph`, `retainContextWhenHidden: true`), CSP with nonce, posts `state` on open/refresh/active-repo change, answers `select` with `details`, handles all `FromWebview` messages; title `Graph · <repo name>`
- [ ] `webview/layout.ts`: port of `visibleRows()` + `layout()` + row geometry (`LANE = 12`, `RH = 26`); `test/layout.test.ts`: linear, branch+merge, two lanes into one parent, WIP row, hidden CI commits (never hide ref tips), parent beyond the loaded set
- [ ] `webview/main.ts`: toolbar (repo switch chip, search, Hide AutoBuild chip, count, refresh), windowed rows (only visible rows in the DOM), ref pills, Jira chip + kind tag, details card (prototype `renderDetails()`), WIP row → file list + "Open Source Control"; ↑/↓ and j/k
- [ ] `webview/styles.css` on `--vscode-*` variables; lane colors `var(--vscode-scmGraph-foreground1..5, <prototype fallbacks>)`
- [ ] `data-vscode-context` on rows + `webview/context` menu commands (Create Branch Here, Copy SHA, Copy Message)
- [ ] `showGraph`, `repoShowGraph`, `toggleAutoBuild`; tree "reveal" sends `reveal`

**Done when:** `pnpm build && pnpm typecheck && pnpm test` pass. User check on Pilot7: graph shape matches `git log --graph --oneline -50`, scrolling 1000 commits is smooth, right-click on a row shows the native menu, file click opens a native diff.

**Session:** sonnet, high; after 4.

### 6. Commands and mutations
Everything that changes a repo, with native prompts.

- [ ] `checkout` quick pick (prototype `qp-checkout`: create new, branches, remote branches, tags → tag shows "detached HEAD isn't supported yet"); `checkoutBranch`, `checkoutRemote` from trees
- [ ] `createBranch` / `createBranchFrom` (input box with `check-ref-format` validation, checks out the new branch), `renameBranch`, `deleteBranch` (modal warning; unpushed note; on NotFullyMerged a second modal "Delete Anyway" → force)
- [ ] `fetch`, `pull`, `push` for the active repo with `withProgress`; PushRejected → error "Can't push refs to remote. Try running 'Pull' first to integrate your changes." with Pull button; NoUpstream on pull → "Publish Branch"; Auth → "Run in Terminal"; Conflict → "Open Source Control"
- [ ] `stash` (input box for an optional message), `stashApply`, `stashPop`, `stashDrop` (modal)
- [ ] copy commands, `openSourceControl`, `refresh`; every mutation refreshes the repo and the graph
- [ ] `menus.commandPalette`: hide commands that need a tree/graph argument (`checkoutBranch`, `checkoutRemote`, `createBranchFrom`, `renameBranch`, `deleteBranch`, `stashApply/Pop/Drop`, `copySha`, `copyMessage`, `copyBranchName`, `copyRepoPath`, `repoShowGraph`, `repoFetch`) or make them prompt when called without one

**Done when:** `pnpm typecheck && pnpm test` pass. User check in a scratch clone: commit on a behind branch (built-in SCM) → Push rejected → Pull merges → Push passes; create/rename/delete a branch; stash with an untracked file and pop it.

**Session:** sonnet, high; after 5.

### 7. Polish and package
- [ ] performance: log activation summary time for `~/Projects` and graph `state` time for Pilot7 to an output channel `Gitsprout`; targets < 2 s and < 1 s; numbers in the report
- [ ] README: install from `.vsix` in VS Code (`code --install-extension`) and Cursor (Extensions → … → Install from VSIX), settings table, shortcuts, screenshots placeholder
- [ ] `CHANGELOG.md` 0.1.0; `pnpm package`

**Done when:** `pnpm package` produces the `.vsix`; the report has the measured times. User check: install the `.vsix` in Cursor and VS Code and work a day without GitKraken.

**Session:** sonnet, high; after 6.

## Session prompts

Launch a stage: `Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: true, prompt: "Read the prompt in /Users/fost/Projects/gitsprout/roadmap-vscode.md, section 'Session prompts → Stage N', and follow it literally. Your last message is the report described there.")`. Acceptance after each stage: `/plan-review`. Whole roadmap on autopilot: `/roadmap-run roadmap-vscode.md`.

Every prompt below shares this tail (the executor must follow it):

```
Common rules: read CLAUDE.md first. Tick roadmap checkboxes only after verifying each one.
Long command output goes to a log file; show only tails and error lines.
Don't commit or push — acceptance does that. Don't touch prototype/ or docs/archive/.
A question the roadmap doesn't answer goes into the report, not into your own invention.
Last message — report: done (files) / deviations from the roadmap / not verified / open questions.
```

### Stage 1

```
Session 1 — Gitsprout extension scaffold · Model: sonnet, effort: high · first session

Work in /Users/fost/Projects/gitsprout (git repo, branch main; contains README.md, CLAUDE.md, roadmap-vscode.md, prototype/, docs/archive/; no package.json yet). Task: scaffold the VS Code extension per stage 1 of roadmap-vscode.md.

Read: roadmap-vscode.md sections "Decisions", "Manifest contributions", "1. Scaffold"; CLAUDE.md. Logo source: the <svg> in .pagehead h1 of prototype/vscode-multi.html.

Already decided, don't ask: pnpm; esbuild with two bundles; engines ^1.90.0; publisher fosteev; vsce package --no-dependencies; commands are stubs in this stage.

Order: stage 1 checkboxes top to bottom.
DoD: pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm package pass; the .vsix exists.
Don't: implement git logic or views content (later stages); add runtime dependencies.
+ Common rules.
```

### Stage 2

```
Session 2 — Gitsprout git layer · Model: sonnet, effort: high · after session 1

Work in /Users/fost/Projects/gitsprout. Task: git runner, parsers and all Repo operations with unit and integration tests, per stage 2 of roadmap-vscode.md. The scaffold exists (stage 1).

Read: roadmap-vscode.md sections "Types", "Git invocations", "2. Git layer"; CLAUDE.md.
Entry points: src/git/{run,parse,repo,types}.ts (create), test/.

Already decided, don't ask: invocations, parsing rules and error kinds exactly as in the contract; src/git/ must not import 'vscode' (tests run in plain node); integration tests build temp repos with the git CLI and never touch a real remote.

Order: types.ts → run.ts → parse.ts + parse.test.ts → repo.ts → repo.integration.test.ts.
From the actual code (stage 1): vitest 4.1 with vitest.config.mts (include test/**/*.test.ts); tsconfig.json is module commonjs without moduleResolution and covers src/ and test/ (TypeScript 7 — tsc is only the checker, esbuild/vitest transpile); tests run as CJS — use __dirname / os.tmpdir(), not import.meta; @types/node 20 — no Node 22-only APIs in src/ (VS Code 1.90 runs Node 20); import Node builtins as 'node:child_process' etc. src/commands/ids.ts + test/manifest.test.ts guard the manifest — leave them alone.
DoD: pnpm typecheck && pnpm test pass.
Don't: views, commands, webview.
+ Common rules.
```

### Stage 3

```
Session 3 — Gitsprout workspace and repositories view · Model: sonnet, effort: high · after session 2

Work in /Users/fost/Projects/gitsprout. Task: repo discovery, registry, Repositories view, repo switching, status bar item, built-in SCM depth check, Fetch All — per stage 3 of roadmap-vscode.md. Repo (src/git/repo.ts) exists from stage 2; reuse it, open only what you edit.

Read: roadmap-vscode.md sections "Decisions", "Manifest contributions", "3. Workspace, repositories view, status bar"; CLAUDE.md. Reference: prototype/vscode-multi.html functions reposPane(), fetchAll(), act() case 'qp-repo', setRepo(), renderStatus().
Entry points: src/extension.ts, src/workspace/, src/views/repositories.ts, src/views/statusBar.ts.

Already decided, don't ask: scan rules and depth; summary via status --porcelain=v2 --branch; watchers + 300 ms debounce + focus refresh; follow active editor by longest root prefix; context key gitsprout.multiRepo.

Order: stage 3 checkboxes top to bottom.
DoD: pnpm typecheck && pnpm test pass.
Don't: branch/remote/stash/tag views, graph, mutations other than fetch.
+ Common rules.
```

### Stage 4

```
Session 4 — Gitsprout ref views and diffs · Model: sonnet, effort: high · after session 3

Work in /Users/fost/Projects/gitsprout. Task: Branches, Remotes, Stashes, Tags tree views for the active repo and the gitsprout: diff provider, per stage 4 of roadmap-vscode.md. Registry and Repo exist (stages 2–3).

Read: roadmap-vscode.md sections "Diff URIs", "Manifest contributions", "4. Ref views and native diffs"; CLAUDE.md. Reference: prototype/vscode-multi.html renderGitsproutBase() (tree rows, descriptions, inline actions) and diffSource() (titles).
Entry points: src/views/{branches,remotes,stashes,tags}.ts, src/diff/provider.ts, src/extension.ts, src/workspace/registry.ts (events).

Already decided, don't ask: contextValues and inline groups from the manifest section; untracked files open via vscode.open; titles copy the prototype.

Order: diff provider + tests → branches → remotes → stashes (with files) → tags.
DoD: pnpm typecheck && pnpm test pass.
Don't: graph webview; checkout/branch/stash mutations (stage 6) — inline actions may call stub commands.
+ Common rules.
```

### Stage 5

```
Session 5 — Gitsprout commit graph webview · Model: sonnet, effort: high · after session 4

Work in /Users/fost/Projects/gitsprout. Task: the graph WebviewPanel and its webview UI ported from the prototype, per stage 5 of roadmap-vscode.md. Registry, Repo, diff helpers and trees exist (stages 2–4).

Read: roadmap-vscode.md sections "Webview protocol", "Manifest contributions", "5. Commit graph webview"; CLAUDE.md. Reference: prototype/vscode-multi.html functions visibleRows(), layout(), rowSvg(), msgHtml(), refPills(), renderGraph(), renderDetails() and the CSS for .gr/.gcols/.ref/.jira/.kind/.details. Port the layout algorithm as-is; it is already validated.
Entry points: src/graph/{panel,protocol}.ts, webview/{main,layout}.ts, webview/styles.css, scripts/build.mjs (webview bundle), src/extension.ts.

Already decided, don't ask: plain TS, no framework; manual windowing with fixed 26 px rows; --vscode-* theme variables; native webview/context menus via data-vscode-context; Jira links through openUrl → vscode.env.openExternal; hideCi persisted in settings.

Order: protocol.ts → layout.ts + layout.test.ts → panel.ts → main.ts + styles.css → context menu commands → reveal from trees.
DoD: pnpm build && pnpm typecheck && pnpm test pass.
Don't: staging/commit UI; mutations (stage 6).
+ Common rules.
```

### Stage 6

```
Session 6 — Gitsprout commands and mutations · Model: sonnet, effort: high · after session 5

Work in /Users/fost/Projects/gitsprout. Task: all repo-changing commands with native quick picks, input boxes, modals and notifications, per stage 6 of roadmap-vscode.md. Repo methods for every mutation exist and are tested (stage 2); views and graph exist (stages 3–5).

Read: roadmap-vscode.md sections "Decisions", "Git invocations" (error kinds), "6. Commands and mutations"; CLAUDE.md. Reference for copy and flows: prototype/vscode-multi.html act() cases qp-checkout, qp-create, qp-rename, delete, qp-stash, stash-*, and doPull()/doPush() notification texts.
Entry points: src/commands/, src/extension.ts, src/views/* (stub commands to replace).

Already decided, don't ask: pull --no-rebase --no-edit; error → action mapping (PushRejected→Pull, NoUpstream→Publish Branch, Auth→Run in Terminal, Conflict→Open Source Control); every mutation refreshes the repo and the graph.

Order: stage 6 checkboxes top to bottom.
DoD: pnpm typecheck && pnpm test pass.
Don't: staging/commit; reset/revert/cherry-pick.
+ Common rules.
```

### Stage 7

```
Session 7 — Gitsprout polish and package · Model: sonnet, effort: high · after session 6

Work in /Users/fost/Projects/gitsprout. Task: timing output, README install docs, CHANGELOG, final .vsix, per stage 7 of roadmap-vscode.md.

Read: roadmap-vscode.md section "7. Polish and package"; CLAUDE.md; README.md.
Already decided, don't ask: no marketplace/Open VSX publishing; README in English.
DoD: pnpm package produces the .vsix; report contains the measured activation and graph times (run against /Users/fost/Projects read-only: summary and log only, no fetch).
Don't: new features.
+ Common rules.
```

## Risks and open questions

- **Cursor compatibility.** Cursor tracks a recent VS Code, so `^1.90` should be fine; `scmGraph.*` colours may be missing there → CSS fallbacks are mandatory. Checked in stage 7 user check.
- **40 repos on activation.** 40 `git status` processes at concurrency 8 should take ~1 s; if not, summaries load lazily per expanded group. Measured in stage 7.
- **Watchers.** 40 × 6 glob watchers may hit VS Code's watcher limits on huge folders; fallback is focus-refresh only (setting, post-MVP).
- **Auth.** SSH agent keys work; passphrase prompts and HTTPS without a credential helper fail fast and go through "Run in Terminal".
- **Built-in SCM depth.** Without raising `git.repositoryScanMaxDepth`, built-in Source Control won't see most repos in `~/Projects`; stage 3 prompts for it.
- Open for the user: none blocking. Marketplace/Open VSX publishing, a file-status overlay in the Repositories view, reset/revert/cherry-pick are post-MVP.

## Order of work

Sequential, one repo: 1 → 2 → 3 → 4 → 5 → 6 → 7. Each stage ends with `/plan-review` (Opus): compare against this file, fix or document deviations, run "Done when", commit and push to `main`. User checks pile up in the acceptance reports and block only if they fail.
