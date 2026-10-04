# Gitsprout VS Code extension — MVP

> Status: stage 7 accepted 2026-10-04 · MVP complete, user checks pending (see roadmap-vscode.pending.md) · stages 1–6 accepted 2026-10-03…04 · created 2026-10-03 · executors tick checkboxes as each step is verified, not when it "should work".

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
  | 'LocalChanges' | 'NotFullyMerged' | 'Auth' | 'NothingToStash' | 'Cancelled' | 'Other';
export class GitError extends Error { constructor(public kind: ErrorKind, message: string, public stderr: string, public args: string[], public stdout = '') { super(message); } }

export interface SummaryStatus { branch: string | null; sha: string | null; upstream: string | null; ahead: number; behind: number; changes: number }  // Repo.summary()
export interface RepoSummary extends SummaryStatus { root: string; name: string; relPath: string; group: string }  // group = first segment of relPath ('' for a top-level repo); filled by the registry
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
export interface StashFile extends FileStat { untracked: boolean }               // Repo.stashFiles(); add/del always null
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
| `stashFiles(i \| sha)` | `stash show --name-status -z --include-untracked <stash>` (`<stash>` = `stash@{i}` or, preferably, the stash sha; git < 2.32: without the flag, `^3` files appended as `A`) | add/del null; mark files that exist only in `stash@{i}^3` as untracked (`rev-parse -q --verify stash@{i}^3`, then `ls-tree -r --name-only -z stash@{i}^3`) |
| `show(ref, path)` | `show <ref>:<path>`; ref `:` → `show :0:<path>` (conflicted file → `:2:<path>`, ours) | content for the diff provider; `''` ref or missing → empty string |
| `checkout(name)` | `switch <name>` | "would be overwritten" → LocalChanges |
| `checkoutRemote(r)` | local = text after first `/`; exists → `switch <local>`, else `switch --track <r>` | |
| `createBranch(name, start, checkout)` | `check-ref-format --branch <name>`, then `branch --no-track <name> <start>` or `switch --no-track -c <name> <start>` | never tracks `start`; Push publishes it |
| `renameBranch(old, new)` | `branch -m <old> <new>` | |
| `deleteBranch(name, force)` | `branch -d|-D <name>` | "not fully merged" → NotFullyMerged |
| `fetch()` | `fetch --all --prune` | |
| `pull()` | no upstream → NoUpstream; `pull --no-rebase --no-edit` | `CONFLICT (` at line start / `Automatic merge failed` / `you have unmerged files` → Conflict (case-sensitive) |
| `push()` | upstream → `push`; else `push -u <remote> HEAD`, remote = `branch.<b>.pushRemote` → `remote.pushDefault` → `branch.<b>.remote` → `origin` → first; detached → Other | `[rejected]` (covers non-fast-forward / fetch first) → PushRejected |
| `stashPush(msg?)` | `stash push -u [-m <msg>]` | "No local changes to save" → NothingToStash |
| `stashApply/Pop/Drop(i)` | `stash apply|pop|drop stash@{i}` | conflict → Conflict |

Error classification in `run.ts` (stderr, case-insensitive): `not a git repository` → NotARepo; `ENOENT` spawn → GitMissing; `permission denied (publickey` (any method list), `authentication failed`, `could not read username`, `host key verification failed` → Auth; per-method rules above — applied by `Repo` over stderr + stdout, only when `run.ts` returned `Other` (Auth/NotARepo/GitMissing are never overridden); else Other with the last `fatal:`/`error:` line (else the last non-`hint:` line; stdout if stderr is empty). The runner strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and other repo-relocating variables from the inherited env.

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
| stash file | `<stash sha>^1:<path>` (empty if untracked or A) | `<stash sha>:<path>`, or `<stash sha>^3:<path>` if untracked (sha, not `stash@{i}`: indexes shift; the title keeps `stash@{i}`) |

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

- [x] `src/git/run.ts`: `run(root, args, { stdin?, okCodes?, read? })` with env and error classification from the contract; `git.path` passed in by the caller (no `vscode` import in `src/git/`)
- [x] `src/git/parse.ts`: `parseStatusSummary`, `parseStatus`, `parseRefs`, `parseTrack`, `parseLog`, `parseNameStatusZ`, `parseNumstatZ`, `parseStashList` with unit tests (`test/parse.test.ts`): rename, untracked, conflict `u`, binary numstat, `gone`, detached, unborn `(initial)`, body with blank lines
- [x] `src/git/repo.ts`: class `Repo(root, gitPath)` with every method from the invocation table
- [x] `test/repo.integration.test.ts`: temp repos via git CLI (`user.name`/`user.email` set per repo), a bare `origin` and two clones: summary/refs/log/status/commitFiles/stashes; push without upstream sets `-u`; push rejected → PushRejected; pull fast-forward; pull diverged → merge commit with 2 parents; pull conflict → Conflict; checkoutRemote creates tracking branch; deleteBranch unmerged → NotFullyMerged, then force; stash push/pop with an untracked file; clean tree stash → NothingToStash

**Done when:** `pnpm typecheck && pnpm test` pass.

**Session:** sonnet, high; after 1.

**Decisions (2026-10-03, session 2):**
- Layout: `src/git/types.ts`, `run.ts`, `parse.ts`, `repo.ts` (no `vscode` import); `test/parse.test.ts` (19 unit tests, 23 after acceptance), `test/repo.integration.test.ts` (17 tests on temp repos, 21 after acceptance).
- `run(root, args, { gitPath?, stdin?, okCodes?, read? })` returns `{ stdout, stderr, code }`; prepends `-C root -c core.quotePath=false`; env `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` only when `read`. It classifies only NotARepo / GitMissing / Auth; all per-method kinds (PushRejected, Conflict, LocalChanges, NotFullyMerged, NothingToStash) are applied in `Repo` by regex over stderr+stdout, and only to a generic `Other` failure (so Auth is never masked). stdin is always closed (empty) so git never waits on it.
- Contract additions: `GitError` got an optional 5th ctor arg `stdout` (git prints CONFLICT and "No local changes to save" to stdout); `Repo.summary()` returns `SummaryStatus` (branch/sha/upstream/ahead/behind/changes) and `RepoSummary extends SummaryStatus` with the workspace-derived `root/name/relPath/group` (stage 3 fills these); `Repo.stashFiles()` returns `StashFile[]` = `FileStat & { untracked }` (stage 4 diff table needs the flag); `parseRefs(out, head)` takes the already-resolved `Head`; extra pure helper `mergeFileStats(nameStatus, numstat)` used by `commitFiles` (files absent from numstat get null counts).
- Parsers take stdout of exactly the invocations in the table; `parseNameStatusZ` also accepts the `C` (copy) code and maps it to `R`; `T` (type change) maps to `M`.
- `Repo` details the table left open: `log` first runs `rev-parse -q --verify HEAD` and drops `HEAD` when unborn; `show(ref, path)`: `''` ref -> `''`, `':'` -> `show :<path>`, otherwise `show <ref>:<path>`; missing path/revision (fixed set of stderr patterns) -> `''`, other errors rethrown; `pull`/`push` find the upstream via `rev-parse --abbrev-ref --symbolic-full-name @{upstream}` (exit 1/128 = none; detached/unborn = none -> `NoUpstream` for pull, `push -u <remote> HEAD` for push (remote choice: see the contract); no remote -> `Other` "No remote configured"); an invalid branch name from `check-ref-format` is an `Other` GitError with message "'<name>' is not a valid branch name"; `pull`/`stashApply`/`stashPop` map "would be overwritten ..." to LocalChanges in addition to Conflict; a failed `stashPop` keeps the stash (tested).
- Integration tests isolate git via `process.env` set in `beforeAll` and restored in `afterAll` (`HOME` and `GIT_CONFIG_GLOBAL` into the temp dir, `GIT_CONFIG_NOSYSTEM=1`, `GIT_EDITOR=true`, fixed author/committer) plus per-repo `commit.gpgsign=false` and an empty `core.hooksPath`; origin is a local bare repo; the temp dir is removed in `afterAll` (verified none left behind).
- Output is decoded as UTF-8 (`show()` of binary files is lossy; the diff provider shows text only). `maxBuffer` is 256 MB.
- Checks: `pnpm typecheck && pnpm test && pnpm build` pass, 40 tests (4 files) after the session, 48 after acceptance.
- Acceptance review (2026-10-03, two passes) fixed: Conflict regex was case-insensitive and matched branch names (`conflict-*`) in unrelated pull failures → anchored, case-sensitive; push without upstream took the alphabetically first remote → pushRemote/pushDefault/branch.remote/origin/first, detached HEAD → clear error; a branch created from `origin/main` tracked it so Push failed (simple) → `createBranch` uses `--no-track`; `show(':')` threw on conflicted files → `:0:` with `:2:` fallback; error message was often a `hint:` line → prefer `fatal:`/`error:`; `Permission denied (publickey,password)` and host-key failures → Auth; inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` overrode `-C` → stripped; `upstream()` swallowed NotARepo → rethrown; EACCES git path → GitMissing; log body keeps leading indentation. 48 tests (23 parse/run unit, 21 integration).
- Known, left as is: a `\x1f` inside a commit subject shifts log fields (practically never happens); `%(*objectname)` peels one level (a tag of a tag shows the inner tag sha).
- Not verified: other git versions (only 2.49 here; `upstream:track,nobracket`, `switch` and `stash show --include-untracked` need >= 2.32), non-English locale behaviour beyond `LC_ALL=C`, auth failures against a real remote (classification is regex-only), huge repos / performance, Windows paths.

### 3. Workspace, repositories view, status bar
Discovery, the repo registry and everything that is multi-repo.

- [x] `src/workspace/discovery.ts`: `discover(folders, depth, exclude)` per "Decisions"; unit test on a temp dir tree (nested folders, a nested repo, a submodule `.git` file, `node_modules`)
- [ ] (user check: runtime behaviour, see roadmap-vscode.pending.md) `src/workspace/registry.ts`: repos + summaries (concurrency 8 on activation), `activeRepo` (initial: repo of the active editor, else the first), events `onDidChangeRepos` / `onDidChangeActive` / `onDidChangeRepo(root)`, watchers + debounce, refresh on focus, follow active editor (`gitsprout.followActiveEditor`), context key `gitsprout.multiRepo`
- [x] `src/views/repositories.ts`: tree grouped by `group` and sub-folders (prototype `reposPane()`), description `branch* N↓ M↑`, change count, `contextValue: repo`, inline Fetch / Show Graph, click → set active repo; "needs attention" filter (`toggleOnlyAttention`, title shows `39 · 7 need attention`)
- [x] `switchRepository` quick pick grouped by folder (prototype `qp-repo`); status bar item `$(gitsprout-icon or repo) <name>` → switchRepository (single repo: "Gitsprout" → showGraph)
- [x] built-in SCM depth check from "Decisions"
- [x] `fetchAll` with `withProgress` (cancellable, `gitsprout.fetchConcurrency`), summary notification listing repos with incoming commits + "Show Only These"; `repoFetch` for one repo

**Done when:** `pnpm typecheck && pnpm test` pass. User check: open `~/Projects` → Repositories shows 39 repos grouped by at/pilot/tatikoma, the filter leaves the dirty/diverged ones, switching follows editor tabs, Fetch All reports incoming commits.

**Session:** sonnet, high; after 2.

**Decisions (2026-10-03, session 3):**
- Layout. Pure, unit-tested (no `vscode`): `src/util/pool.ts` (`mapPool`), `src/workspace/discovery.ts` (`discover`, `compileExclude`), `src/workspace/model.ts` (`locate`, `subOf`, `makeRepoSummary`, `sameSummary`, `repoForPath`, `scmDepthCheck`), `src/workspace/fetch.ts` (`fetchRepos`, `summarizeFetch`), `src/views/repoModel.ts` (`needsAttention`, `repoDescription`, `viewDescription`, `buildRepoTree`, `buildPickEntries`, `statusBarModel`, `repoTooltip`). VS Code wiring: `src/workspace/registry.ts` (`Registry`), `src/workspace/scmDepth.ts`, `src/views/repositories.ts` (`RepositoriesView`), `src/views/statusBar.ts`, `src/commands/repos.ts`; `src/extension.ts` only wires them. Tests: `test/discovery.test.ts`, `test/workspace.model.test.ts` (30 new tests; 78 in total).
- Contract. `discover(folders, depth, exclude)` returns `DiscoveredRepo { root, gitDir, commonDir, folder, depth }` sorted by path (`gitDir` follows a linked worktree `.git` file; `depth` = segments below the folder, what `git.repositoryScanMaxDepth` counts). The folder itself counts as level 0; a repo there ends the scan of that folder. Dot-dirs and symlinks are always skipped; `node_modules`/`vendor` are skipped only through `gitsprout.scanExclude` (default has both; an empty list scans them). Exclude globs support `**`, `*`, `?`, `{a,b}` over '/'-paths relative to the folder.
- `RepoSummary.relPath`/`group`: with one workspace folder relative to it (`at/mfc`, group `at`, top-level repo group `''`); with several folders prefixed by the folder name (group = folder name). `name` = basename of the root. Sub-folders in the tree = middle segments of `relPath` joined (`at/a/b/c` → sub `a/b`, one node, not nested). Groups sorted by name, top-level repos after the groups.
- `Registry`: `repos` (sorted by relPath), `active`, `get(root)`, `depths()`, `gitPath`, `rescan()` (serialised; also on workspace-folder and `scanDepth`/`scanExclude` changes), `refreshRepo(root)`, `refreshAll()`, `setActive(root)`, events `onDidChangeRepos` (list or grouping changed; also fired once after every scan), `onDidChangeActive(summary)`, `onDidChangeRepo(root)` (fired only when the summary really changed; initial load does not fire per-repo events). Summaries load with concurrency 8; a repo whose `status` fails at scan time is left out (logged to the "Gitsprout" output channel; GitMissing shows one error message), at refresh time the old summary stays. Watchers: `RelativePattern(gitDir, '{HEAD,index,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**}')`, 300 ms debounce per repo; refresh of all repos when the window gains focus. Context keys: `gitsprout.multiRepo` (more than one repo) and `gitsprout.onlyAttention`.
- Active repo: initial = repo of the active file editor, else first; follows editors (longest root prefix on a path boundary) when `gitsprout.followActiveEditor`; selecting a repo in the tree (`onDidChangeSelection`, no extra command, the manifest test stays untouched) or the quick pick sets it; the tree reveals the active repo when the view is visible.
- Repositories view: groups and sub-folders always `Expanded`; description `branch* N↓ M↑` (detached → `(sha7)`); change count is in the tooltip (no badge: that needs a FileDecorationProvider); the active repo has a green `repo` icon (TreeItem cannot be bold). View description `39 · 7 need attention` (+ ` · filtered`). Needs attention = changes > 0 or ahead > 0 or behind > 0; with the filter on the active repo stays visible (prototype). Filter state persists in `workspaceState`. Added to the manifest (cosmetic, ids unchanged): command icons (`$(cloud-download)` fetch/fetchAll/repoFetch, `$(git-commit)` repoShowGraph, `$(filter)` toggleOnlyAttention with `toggled` check, `$(refresh)`), needed for inline/title buttons.
- Status bar: `$(repo) <active name>` → `switchRepository` for several repos, `$(repo) Gitsprout` → `showGraph` for one repo, hidden with no repos. No custom icon font (the roadmap allowed `repo`).
- Quick pick: `createQuickPick` with separators per group (root-level repos under "Workspace"), item description `branch* N↓ M↑ · relPath`, `matchOnDescription`, active repo preselected.
- SCM depth check: runs once per session after the first scan; `git.repositoryScanMaxDepth` (default 1, `-1` = never prompts) vs repo depths; message "Source Control sees N of M repositories." with "Set depth to K" (K = deepest repo, written to the Workspace setting) and "Don't ask again" (`workspaceState`).
- Fetch: `fetchAll` = `withProgress` notification, cancellable (cancel stops starting new fetches; a running `git fetch` is not killed because `Repo.fetch` has no abort), `gitsprout.fetchConcurrency`, each repo's summary re-read after its fetch. Notification text after the prototype: "Fetched N repositories. K have incoming commits: name 3↓, …." + failures ("M failed: name (message)") / "Nothing incoming." / "Cancelled, X not fetched."; "Show Only These" turns the attention filter on (like the prototype, so it also shows dirty/ahead repos, not only incoming ones) and focuses the view. Counts only successfully fetched repos; "incoming" = `behind > 0` after the fetch (includes commits that were already incoming).
- Implemented beyond the checklist (tiny, shared code): `refresh` (rescan + refresh all), `fetch` (fetch of the active repo, same code as `repoFetch`), `repoShowGraph` (sets active, then calls `gitsprout.showGraph`, still a stub until stage 5), `copyRepoPath`, `toggleOnlyAttention`. `registerStubCommands(context, implemented)` skips implemented ids; stage 6 must not re-stub them.
- Not done on purpose: a workspace folder that sits *inside* a repo (no `.git` at or below it) finds nothing (no walk up to the parent); Auth failures during fetch are only listed, no "Run in Terminal" (stage 6).
- Verified: `pnpm build && pnpm typecheck && pnpm test` (78 tests after the session, 81 after review, 6 files); discovery tests run on a temp tree (removed afterwards, none left in the OS temp dir). The registry checkbox stays open: `Registry`, watchers, events and all `vscode`-bound code are only built and typechecked, never executed (VS Code does not run in tests). Not verified (user check): F5 on `~/Projects`, tree rendering/reveal/selection feedback loop, watcher refresh after external git commands, focus refresh cost with ~40 repos, `toggled` icon on the view title, quick pick preselection, progress notification, SCM depth prompt and the setting write, the real number of repos found under `~/Projects`.
- Review (2026-10-03, acceptance of session 3; second pass by an independent reviewer):
  - `Registry.refreshRepo(root)` is serialised per repo: a request during a running `status` queues exactly one more read that starts after it (later requests join it), so a stale result can no longer overwrite a fresh one and watcher + focus + post-fetch refreshes don't spawn parallel `git status` for one repo. Awaiting it guarantees state at least as new as the caller's change.
  - Focus refresh only on a real focus regain (`onDidChangeWindowState` also fires on `active` changes) and never two passes at once.
  - Linked worktrees: `DiscoveredRepo.commonDir` (from `<gitDir>/commondir`); a second watcher `{packed-refs,refs/**}` on it. Submodule = git dir under `/.git/modules/` *without* `commondir` (a worktree of a repo under a `modules` folder is no longer skipped).
  - Repo rows get `TreeItem.command` = internal `gitsprout._activateRepository` (not contributed): a click on the already-selected row (stale selection after follow-editor switched repos while the view was hidden) now activates it.
  - `dispose()` during a running scan no longer leaks watchers; SCM depth setting write errors are caught and shown; "Show Only These" is offered only with several repos (the view is hidden otherwise).
  - Real `~/Projects` (read-only discover, depth 3): 61 repos (at 17, pilot 12, tatikoma 15, the rest personal), 16 ms; depths 1/2/3 = 12/39/10, so the SCM depth prompt will offer "Set depth to 3".
- Review follow-up (stage 4): a workspace folder that sits inside a repo (nothing at or below it) is no longer empty. `discoverWithParents(folders, depth, exclude, gitPath)` in `src/workspace/discovery.ts` wraps `discover`: for every folder with no repo under it it runs `git rev-parse --show-cdup` (cwd = the folder, via `run.ts`; review 2026-10-04: not `--show-toplevel`, which returns the realpath — symlinks, `/var` → `/private/var` — so the root would not contain the folder or match editor paths) and adds the enclosing repo (`folder` = the workspace folder, `depth` 0, so the SCM depth check ignores it; `relPath` = basename, group `''`, because `locate()` gives a root outside every folder its basename). Not added: submodule checkouts, folders outside any repo, a toplevel that a scan already found, a folder with any found repo below it (overlapping workspace folders). `Registry.doScan` calls it. Test: `test/discovery.test.ts` (temp repo, folder = `src/deep`). The "Not done on purpose" note above is superseded for the walk-up part. Not verified: F5 on a monorepo subfolder.

### 4. Ref views and native diffs
The four trees for the active repo plus the diff provider.

- [ ] (user check: runtime behaviour, see roadmap-vscode.pending.md) `src/views/branches.ts`: locals grouped by first `/` segment, HEAD with `$(check)`, description `N↓ M↑` / `gone` / `local only`, `contextValue` `branch.local(.head)`, inline Checkout (non-HEAD) or Pull/Push (HEAD); click → reveal commit in the graph (if open)
- [ ] (user check: runtime behaviour) `src/views/remotes.ts` (grouped by remote, inline "Checkout as local branch"), `src/views/stashes.ts` (expandable to files, inline Apply/Pop/Drop, file click → stash diff), `src/views/tags.ts`
- [ ] (user check: runtime behaviour) titles follow the active repo (`TreeView.description = repo name` in multi-repo)
- [x] `src/diff/provider.ts` + `openDiff` helpers for every row of the "Diff URIs" table; unit test for URI encode/decode and title building (the pure parts are tested; the `vscode.diff` call itself is user check)

Note (stage 1 review): the stage 1 `view/item/context` menus are placeholders — add inline Pull/Push for `branch.local.head` and a `stashFile` entry here, against the prototype.

**Done when:** `pnpm typecheck && pnpm test` pass. User check: trees match `git branch -vv`, `git stash list`, `git tag`; a stash file opens a side-by-side diff.

**Session:** sonnet, high; after 3.

**Decisions (2026-10-03, session 4):**
- Layout. Pure, unit-tested (no `vscode`): `src/diff/uri.ts` (`encodeQuery`/`decodeQuery`/`uriParts`, `DiffPlan`/`Side`, `commitFilePlan`, `unstagedPlan`, `stagedPlan`, `stashFilePlan`, `diffTitle`), `src/diff/content.ts` (`readTarget` = what the provider serves), `src/views/refsModel.ts` (`branchDescription`, `branchContext`, `buildBranchTree`, `buildRemoteTree`, `sortTags`, `stashFileRow`, `repoViewDescription`). VS Code wiring: `src/diff/provider.ts` (`GitContentProvider`, `registerDiffProvider`, `gitUri`, `openPlan`), `src/views/refsStore.ts` (`RefsStore`, `createRefTree`, reveal hook), `src/views/{branches,remotes,stashes,tags}.ts`, `src/commands/refs.ts` (`registerRefViews`, `REF_COMMAND_IDS`). `src/views/emptyTree.ts` is deleted (all five views are real). Tests: `test/diff.uri.test.ts`, `test/refs.model.test.ts`, `test/diff.content.test.ts` (plans resolved to text on a temp repo: unborn staged add, commit M/A/D/R/root, staged vs unstaged, untracked, stash tracked + untracked via `^3`).
- Diff contract. A plan is `{kind:'diff', left, right, title}` or `{kind:'open', path}`; a side is `{kind:'git', ref, path}` (`ref ''` = empty document, the path is kept for the tab/language) or `{kind:'file', path}` (relative to the root). `openPlan(root, plan)` turns it into `vscode.diff` / `vscode.open`. Stage 5 uses `commitFilePlan(sha, file, commit.parents[0])` (the parent is only for the title: `06da7e4 ↔ bb3c907`, `empty ↔ …` for a root commit), `unstagedPlan(change)`, `stagedPlan(change, head.sha === null)`. Refinements over the table: an added file (commit/staged/stash) and a root commit get an empty left without a git call; a deleted file gets an empty right (also unstaged D: the file is gone from disk, `vscode.diff` would fail); renames read the left from `origPath`; unstaged conflicted `U` diffs index (ours, via `show(':')`) vs the file.
- Index documents (`ref ':'`) go stale after staging: the provider remembers the ones it served per repo and fires `onDidChange` for them on `Registry.onDidRefreshRepo`. Review 2026-10-04: every ref that is not a full commit id (`isVolatileRef` in `src/diff/uri.ts`: `:`, `HEAD`, names) is tracked the same way — the `HEAD` side of a staged diff went stale after a commit; closed documents are pruned on the next invalidate.
- Registry: new event `onDidRefreshRepo(root)`, fired after every completed read of a repo, also when the summary did not change. Needed because a new tag/branch/stash does not change the summary, so `onDidChangeRepo` (changed-only, unchanged semantics) would leave the trees stale. `RefsStore` reloads `refs()` + `stashes()` of the active repo on active change, repo list change and `onDidRefreshRepo` of the active root (latest request wins, a failed load empties the trees and logs).
- Trees. Tree items have a stable `id` = `<root>|<key>` (expansion survives refreshes). Commands receive the tree node, not a bare string: branches → `BranchLeaf` (`.branch.name`, `.branch.sha`, `.isHead`), remotes → `RemoteLeaf` (`.ref.name` = `origin/develop`), tags → `Tag`, stashes → `StashNode` (`.stash.index`), stash files → `StashFileNode` (`.root`, `.stash`, `.file`). Stage 6 commands must accept these (and prompt when called without one). Branch folders: split at the first `/` only, a leading/trailing `/` keeps the branch top-level; folders first. Remotes: split at the first `/` (a remote name containing `/` is not supported), numeric-aware sort. Tags: numeric-aware descending (`v1.10` before `v1.9`; the prototype used plain reverse sort). Detached HEAD: no row is marked. Remote group description = branch count (the prototype showed the host; that needs `git remote get-url`, not worth a Repo method). Stash file rows use a status icon (`diff-modified/added/removed/renamed`, coloured) instead of the prototype's letter badge (a letter needs a FileDecorationProvider, same call as the change count in stage 3); untracked files say so in the tooltip. Stash files load on expand and are cached per stash sha until the next refresh.
- Click → reveal: every ref row runs the internal `gitsprout._revealCommit` (not contributed) with the commit sha; it fires `onReveal` exported from `src/views/refsStore.ts`. Nothing listens until stage 5 (`panel.ts` subscribes and posts `reveal`), so "if open" is vacuously true now.
- Manifest (cosmetic + one command). Icons for commands that show up as inline/title buttons (`pull $(arrow-down)`, `push $(arrow-up)`, `showGraph $(graph)`, `checkoutBranch`/`checkoutRemote $(arrow-swap)`, `stash $(add)`, `stashApply $(check)`, `stashPop $(export)`, `stashDrop $(trash)`); inline Pull/Push on `branch.local.head`; `viewsWelcome` ("No stashes." etc.) for the four trees. Scope addition: the stage 1 note asked for a `stashFile` menu entry, and the command list had nothing to put there, so `gitsprout.openStashFile` ("Open Changes") was added to `COMMAND_IDS`/manifest (the click on a stash file runs it too), hidden from the palette through the first `menus.commandPalette` entry (`when: false`). Stage 6 appends to that array instead of creating it.
- Not done / not verified: `vscode.diff` and the provider are only built and typechecked, never executed (user check: stash file opens a side-by-side diff, a staged-then-reopened index document refreshes); tree rendering, inline buttons, `TreeView.description`, `viewsWelcome`, reload on tag/branch/stash creation in a terminal; the "remote branch deleted → gone" and `N↓ M↑` descriptions are covered by the pure model tests, not against a live repo. `pnpm build && pnpm typecheck && pnpm test` pass (101 tests, 9 files, 20 new incl. the 2 step-0 tests); temp dirs are removed by the tests.
- Review (2026-10-04): stash files are listed by the stash sha (`repo.stashFiles(stash.sha)`), not the index, so a click on a stale node never shows another stash; `readTarget` returns `Binary file <oid7> (N bytes)` for a blob with a NUL in its first 8000 bytes (`Repo.blobInfo` = `cat-file --batch-check`); `RefsStore` fires only when refs/stashes/repo actually changed (focus refreshes no longer redraw the trees or re-run `stash show`) and sets context `gitsprout.refsState` = `none`/`error`/`ok`, which picks the `viewsWelcome` text (no repo / unreadable / "No branches."); tree providers dispose their emitters; a shared failed stash read reports once.

### 5. Commit graph webview
The graph tab, ported from the prototype, talking the protocol.

- [ ] (user check: runtime in a live VS Code; message validation and the CSP document are unit-tested) `src/graph/panel.ts`: single `WebviewPanel` (`viewType: gitsprout.graph`, `retainContextWhenHidden: true`), CSP with nonce, posts `state` on open/refresh/active-repo change, answers `select` with `details`, handles all `FromWebview` messages; title `Graph · <repo name>`
- [x] `webview/layout.ts`: port of `visibleRows()` + `layout()` + row geometry (`LANE = 12`, `RH = 26`); `test/layout.test.ts`: linear, branch+merge, two lanes into one parent, WIP row, hidden CI commits (never hide ref tips), parent beyond the loaded set (+ `test/graph.integration.test.ts`: log/refs/status of a real temp repo with a merge and CI commits through the same code)
- [ ] (user check: runtime, needs a browser/webview) `webview/main.ts`: toolbar (repo switch chip, search, Hide AutoBuild chip, count, refresh), windowed rows (only visible rows in the DOM), ref pills, Jira chip + kind tag, details card (prototype `renderDetails()`), WIP row → file list + "Open Source Control"; ↑/↓ and j/k (the HTML builders in `webview/render.ts` are unit-tested for escaping/links/context attribute; DOM glue, windowing and keys are not)
- [ ] (user check: look in light/dark/high-contrast themes) `webview/styles.css` on `--vscode-*` variables; lane colors `var(--vscode-scmGraph-foreground1..5, <prototype fallbacks>)`
- [ ] (user check: native menu) `data-vscode-context` on rows + `webview/context` menu commands (Create Branch Here, Copy SHA, Copy Message) — the attribute is unit-tested, `copySha`/`copyMessage` are implemented, `createBranchFrom` is still the stage 6 stub
- [ ] (user check: runtime) `showGraph`, `repoShowGraph`, `toggleAutoBuild`; tree "reveal" sends `reveal`

**Done when:** `pnpm build && pnpm typecheck && pnpm test` pass. User check on Pilot7: graph shape matches `git log --graph --oneline -50`, scrolling 1000 commits is smooth, right-click on a row shows the native menu, file click opens a native diff.

**Session:** sonnet, high; after 4.

**Decisions (2026-10-04, session 5):**
- Layout. Pure and unit-tested (no `vscode`/DOM): `webview/layout.ts` (`visibleRows`, `layout`, `rowSvg`, `laneX`, `graphWidth`, `LANE`/`RH`), `webview/format.ts` (`esc`, `fmtAgo(Long)`, `parseSubject` = Jira key + `[ KIND ]`, `jiraUrl`, `ciMatcher`), `webview/render.ts` (HTML builders: `rowHtml`, `pillsHtml`, `subjectHtml`, `commitDetailsHtml`, `wipDetailsHtml`, `refsBySha`), `src/graph/validate.ts` (`parseFromWebview` and friends, `isAllowedUrl`, `shaFromArg`, `graphHtml` = the CSP document). DOM glue: `webview/main.ts` (+ `webview/css.d.ts` for the `import './styles.css'`), `webview/styles.css`. VS Code side: `src/graph/protocol.ts`, `src/graph/panel.ts` (`registerGraph`, `GRAPH_COMMAND_IDS`). Tests: `test/layout.test.ts`, `test/graph.render.test.ts`, `test/graph.integration.test.ts` (real temp repo with a merge + CI commits: log/refs/status → rows → lanes).
- Protocol additions over the contract (all additive): `ToWebview` `error { message }` (no repo / history unreadable; the webview shows the text instead of the graph), `details.error?` (files could not be read), `settings.logLimit` (the count reads `1000+ commits` when the history was cut). `wip` is `null` when there are no staged/unstaged files (the WIP row exists only when dirty). Every message from the webview is narrowed by `parseFromWebview` (unknown shape → ignored); `openWipFile` only opens files that are in the extension's own last status list; `openUrl` only passes `http(s)` URLs under a configured `gitsprout.jira` base; `select`/`openCommitFile` only for shas of the loaded history.
- Panel behaviour. One tab, follows the active repo (`onDidChangeActive`), re-sends `state` on `onDidRefreshRepo(active)`, `onDidChangeRepos` and a change of `ciPattern|hideCi|jira|logLimit`. `state` = `repo.log(logLimit)` + `refs()` + `status()` in parallel, latest request wins; an identical `state` (JSON compare) is not re-posted, so focus refreshes do not redraw. While the tab is hidden a refresh only sets a dirty flag; the reload happens when it becomes visible. `busy` is posted around a load (the webview shows "Loading…" after 250 ms, so quick loads do not flicker). Refresh button → `registry.refreshRepo(active)`, the event then reloads. Tree click (`onReveal`) → `reveal` message and the tab is brought to front without taking focus; nothing happens when the graph is not open. `showGraph` with no repo → information message. `retainContextWhenHidden` is on, so the webview keeps its selection/scroll; no serializer (the tab is not restored after a window reload).
- `hideCi` is persisted by writing the setting (workspace value if the workspace sets one, else user settings); the webview applies the toggle locally at once and the config echo re-sends the same state. `toggleAutoBuild` flips the same setting. The label reads "Hide AutoBuild" for the default `ciPattern`, "Hide CI" otherwise. Ref tips (branch, remote, tag, HEAD sha) are never hidden.
- Graph look. Lane colours are 5 (`--g0..--g4` = `scmGraph.foreground1..5`; the prototype had 6) plus `--g5` (`charts.blue`) used for remote pills only; light-theme fallbacks only matter when a theme lacks `scmGraph.*`. Pills/colours use classes (`.ref.c0..c5`) and the document has no inline `style=` or inline script (CSP `style-src ${cspSource}`, `script-src 'nonce-…'`, no `unsafe-inline`); dynamic sizes are set through CSSOM (`el.style.setProperty`). Relative dates add `mo`/`y` after 60 days (the prototype stopped at `d`). Windowing: rows are fixed 26 px, the slice (visible ± 12 rows) is rendered between top/bottom padding, header 24 px sticky. Search dims non-matching rows (prototype); Enter / Shift+Enter jumps to the next / previous match (small addition). Selecting a commit asks `select` once per sha and caches the file list (shas are immutable); parents in the details card are links when the parent is a shown row (in the loaded history and not hidden by Hide CI).
- Deviations. (1) No "copy SHA" icon button in the details card: the protocol has no copy message and `navigator.clipboard` in a webview is unverified; the row context menu has Copy Commit SHA. (2) The repo chip is always shown (the state carries no multi-repo flag); with one repo the quick pick lists one entry. (3) `copySha` and `copyMessage` are implemented here (they are the graph's own context-menu items; both read the commit from the panel's loaded history and take `{sha}` or a bare sha); `createBranchFrom` (Create Branch Here…) stays the stage 6 stub. Outside the graph (command palette) the two copy commands show "pick a commit in the graph". (4) `.vscodeignore` gets `!dist/*.css` (the webview bundle emits `dist/webview.css`).
- Review (2026-10-04): `isAllowedUrl` compares parsed URLs (same origin, `href` prefix of the parsed base, no userinfo) — a base without a trailing slash no longer admits `https://base@evil/` or `https://base.evil/`; the no-repo path of `load()` clears `busy` (a superseded load did not); `post()` is a no-op after dispose (a `select` answered after the tab closed threw "Webview is disposed"); a tree `reveal` for a sha the stale (hidden, dirty) tab does not have yet is kept and applied on the next `state`; Hide CI moves the selection off a commit it just hid; scroll re-render is coalesced to one rAF; the keep-set for CI hiding is `keepSet()` in `webview/render.ts` and unit-tested (incl. detached HEAD). Tests 135.
- Not done / not verified (needs the user in a live VS Code/Cursor): the panel opens and renders; `data-vscode-context` produces the native menu and which argument shape the `webview/context` commands really receive (handled: `{sha, …}` object or string); lane drawing vs `git log --graph --oneline -50`; scrolling 1000 commits; keyboard navigation; `reveal` from the trees; file click → native diff; light/dark/high-contrast look; `Hide AutoBuild` persistence; CSP errors in the webview developer tools. No webview/DOM code was executed (no browser by instruction). `pnpm build && pnpm typecheck && pnpm test` pass (134 tests, 12 files; 33 new).

### 6. Commands and mutations
Everything that changes a repo, with native prompts.

- [ ] (user check: quick pick / modals / notifications in a live VS Code; the entries, wording, validation and error mapping are unit-tested, the Repo calls run against temp repos) `checkout` quick pick (prototype `qp-checkout`: create new, branches, remote branches, tags → tag shows "detached HEAD isn't supported yet"); `checkoutBranch`, `checkoutRemote` from trees
- [ ] (user check: input box / modals) `createBranch` / `createBranchFrom` (input box with `check-ref-format` validation, checks out the new branch), `renameBranch`, `deleteBranch` (modal warning; unpushed note; on NotFullyMerged a second modal "Delete Anyway" → force)
- [ ] (user check: notifications and their buttons; PushRejected→Pull, NoUpstream→Publish, Conflict, Auth→terminal line are unit-tested over real GitErrors) `fetch`, `pull`, `push` for the active repo with `withProgress`; PushRejected → error "Can't push refs to remote. Try running 'Pull' first to integrate your changes." with Pull button; NoUpstream on pull → "Publish Branch"; Auth → "Run in Terminal"; Conflict → "Open Source Control"
- [ ] (user check: input box / modal) `stash` (input box for an optional message), `stashApply`, `stashPop`, `stashDrop` (modal)
- [ ] (user check: runtime) copy commands, `openSourceControl`, `refresh`; every mutation refreshes the repo and the graph
- [x] `menus.commandPalette`: hide commands that need a tree/graph argument (`checkoutBranch`, `checkoutRemote`, `createBranchFrom`, `renameBranch`, `deleteBranch`, `stashApply/Pop/Drop`, `copySha`, `copyMessage`, `copyBranchName`, `copyRepoPath`, `repoShowGraph`, `repoFetch`) or make them prompt when called without one (hidden; `test/commands.messages.test.ts` checks the manifest; called without an argument anyway they show a hint)
- [x] From the user (stage 3/4/5 scope decisions): `AbortSignal` + `timeout` in `run()` (Fetch All cancel kills `git fetch`, cancelled ≠ error; test with a hanging fake git), no climbing to `$HOME` in `discoverWithParents` (test), "Copy SHA" button in the commit card (`copy { text }` message, validation test), repo chip hidden with one repo (`state.multiRepo`, test)

**Done when:** `pnpm typecheck && pnpm test` pass. User check in a scratch clone: commit on a behind branch (built-in SCM) → Push rejected → Pull merges → Push passes; create/rename/delete a branch; stash with an untracked file and pop it.

**Session:** sonnet, high; after 5.

**Decisions (2026-10-04, session 6):**
- Layout. `src/commands/messages.ts` — pure and unit-tested: branch-name validation (prototype `branchNameError` + `@{`, `//`, trailing `.`), checkout quick pick entries, argument extraction from tree nodes / graph context (`refNameFromArg`, `localBranchFromArg`, `remoteBranchFromArg`, `stashShaFromArg`), pull/push/delete wording, `errorPlan` (GitError kind → text + action ids), `terminalCommand`/`shQuote`. `src/commands/report.ts` — shows an `errorPlan` as a notification and runs the chosen action. `src/commands/mutations.ts` — the 15 commands (`MUTATION_COMMAND_IDS`: pull, push, checkout, checkoutBranch, checkoutRemote, createBranch(From), renameBranch, deleteBranch, stash, stashApply/Pop/Drop, copyBranchName, openSourceControl). `registerStubCommands` now has nothing left to stub (kept, a no-op).
- All mutations act on the **active repo** (trees and graph show it; tree nodes carry no root except stash files). One `mutate()` wrapper: per-repo busy lock (a second click shows "another operation is still running"), optional `withProgress(Window)`, `registry.refreshRepo(root)` after success **and** after failure (a conflicting pull changes the repo), then the info notification or `errorPlan`.
- Pull/push texts are derived from `summary()` before/after, not from git output. `pullMessage` reads the outcome from HEAD (`before.behind` is only as fresh as the last fetch): unchanged → "Already up to date.", no local commits → "Fast-forwarded 'b' to abc1234.", else "Branches had diverged. Merged origin/x into 'b'." (the prototype's "N commits" count and merge-commit sha are not available without more git calls). Push: "Published 'b' to origin/b." / "Pushed N commits to origin/b." / "Everything up-to-date.".
- Errors (`errorPlan`): PushRejected → Pull; NoUpstream → "Publish Branch" (= `push`, which publishes with `-u`); Auth (fetch/pull/push) → "Run in Terminal": integrated terminal with `cwd` = repo, and the failed command replayed (`git` + `GitError.args` without the `-C <root> -c core.quotePath=false` prefix, shell-quoted, executed at once); Conflict → Open Source Control (a conflicting `stash pop` keeps the stash, the text says so); LocalChanges → "Stash Changes" + "Open Source Control" (for apply/pop only SCM). Cancelled shows nothing. "Show Command Output" from the prototype is not done: the details go to the `Gitsprout` output channel only.
- New error kind `Cancelled` in `ErrorKind` (an aborted `run()`); a timeout is an ordinary `Other` ("git timed out after N s"). `Repo.fetch({ signal, timeoutMs })`, default timeout `FETCH_TIMEOUT_MS` = 300 s of total time for every fetch (single and Fetch All; 120 s in the session, raised in review: it is total time, not a stall timer, and a big first fetch must not be killed). `fetchRepos` passes the signal to `fetchOne` and counts a `Cancelled` fetch as **skipped**, not failed ("Cancelled, N not fetched."); the Cancel button of the Fetch All notification aborts an `AbortController`, which kills the running `git fetch` processes. Single-repo Fetch errors now go through the same `errorPlan` (Auth → Run in Terminal).
- Checkout: current branch → no-op; tag → warning (detached HEAD is out of scope); remote → `checkoutRemote`, with "Created branch 'x' tracking 'origin/x'." only when the local branch did not exist. Create branch always checks the new branch out (`switch --no-track -c`, per the Git invocations table) and starts from `HEAD`, a tree ref (branch/remote/tag name) or a graph sha. Delete refuses the checked-out branch up front; the modal detail is `deleteDetail` (never pushed / N commits not pushed to up / up stays on the server / upstream gone); NotFullyMerged → second modal "Delete Anyway" → `-D`.
- Stash: the clean-tree check uses a fresh `summary().changes` ("There are no changes to stash."), message input is optional, Escape cancels. apply/pop/drop take the stash **sha** from the node and re-resolve `stash@{i}` right before running (also after the drop modal); a vanished stash → "that stash no longer exists".
- Palette: the 14 commands that need an argument are `when: false`; without one they would only show a hint, so no extra prompts were built.
- Stage 5 deviations resolved: Copy SHA button in the commit card (`FromWebview` `copy { text }`, 1..1000 chars, written to the clipboard by the panel with a status-bar flash); `ToWebview.state.multiRepo` (`stateMessage()` in `src/graph/validate.ts`) hides `#repo` with a single repo. Stage 3/4 decisions: `discoverWithParents(…, home = os.homedir())` skips an enclosing repo rooted at `home` (compares real paths, so a symlinked home counts).
- Tests (+20): `test/commands.messages.test.ts` (messages, manifest palette, copy validation, multiRepo flag, Copy SHA in the card HTML), `test/run.cancel.test.ts` (abort/pre-aborted/timeout with a hanging fake git, `Repo.fetch`, `fetchRepos` skipped-vs-failed), `test/repo.integration.test.ts` "command flows" (the DoD scenario on temp repos with a bare origin: commit on a behind branch → push rejected → pull merges → push passes; first push publishes; NoUpstream/Conflict plans; create from sha, rename, delete + force; stash with an untracked file found by sha after the list shifted, then pop; LocalChanges plan), `test/discovery.test.ts` (home guard).
- Review (2026-10-04, after session 6): (1) `run()` moved from `execFile` to `spawn`: a call with `signal`/`timeout` runs `detached` (own process group, POSIX) and abort/timeout kill the whole group — `execFile` killed only `git` and does not pass `detached` on, so `fetch --all`'s per-remote `git fetch` and ssh kept running after Cancel (reproduced; regression test with a spawning fake git); (2) `--end-of-options` before every ref/name in `switch`/`branch` (refs starting with `-` arrive with a clone: `switch -d` detached HEAD, a tag `--discard-changes` was read as an option; integration test); (3) Pull/Push progress is a cancellable notification (as `withProgress` in the prototype), Cancel aborts `Repo.pull/push({ signal })` — before, a hung push held the per-repo busy lock until reload; (4) error buttons Pull / Publish Branch / Stash Changes run in the repo the error came from (`gitsprout.pull|push|stash` accept a root string), not whatever is active by then; (5) `shQuote` quotes a leading `=` (zsh `=cmd` expansion); tests run quoted words through `/bin/sh` and replay a real `run()` failure; (6) Checkout of `origin/x` onto an existing local `x` says so when `x` tracks something else or is behind (`existingBranchNote`); (7) fetch timeout 300 s (above). Known gap: Fetch does not take the mutation busy lock — see Risks.
- Not verified (user check, live VS Code/Cursor): all prompts and notifications as shown (quick pick, input boxes, modals incl. button labels, progress), "Run in Terminal" actually opening the terminal and running the command, Auth on a real remote, `webview/context` Create Branch Here in the graph, inline/context menu placement of the new commands in the trees, that the graph and trees reload after each mutation, Cancel in Fetch All killing real fetches.

### 7. Polish and package
- [x] performance: log activation summary time for `~/Projects` and graph `state` time for Pilot7 to an output channel `Gitsprout`; targets < 2 s and < 1 s; numbers in the report
- [x] README: install from `.vsix` in VS Code (`code --install-extension`) and Cursor (Extensions → … → Install from VSIX), settings table, shortcuts, screenshots placeholder
- [x] `CHANGELOG.md` 0.1.0; `pnpm package`
- [x] user decisions: graph tab restored after reload (`registerWebviewPanelSerializer` + `onWebviewPanel:gitsprout.graph`), "Run in Terminal" types without Enter, "Show Command Output" in fetch/pull/push error notifications (live behaviour: user check)

**Done when:** `pnpm package` produces the `.vsix`; the report has the measured times. User check: install the `.vsix` in Cursor and VS Code and work a day without GitKraken.

**Session:** sonnet, high; after 6.

**Decisions (2026-10-04, session 7):**
- Timings, measured read-only with a node script over the real `src/` modules (`discoverWithParents` + `Repo.summary()` at concurrency 8, as `Registry.doScan`; `Repo.log(1000)` + `refs()` + `status()` in parallel, as `GraphPanel.load`), 3 runs each, no fetch/pull/checkout. Activation summary for `/Users/fost/Projects` (62 repos, depth 3): 652 / 481 / 463 ms total (discovery 4-14 ms, summaries ~460-640 ms) vs. target < 2 s. Graph `state` for `/Users/fost/Projects/pilot/Pilot7` (the only Pilot7 repo, 51 472 commits, branch `develop`; 1000 commits, 37 local / 54 remote branches, 3 tags): 117 / 109 / 111 ms vs. target < 1 s. The extension writes both to the `Gitsprout` channel: `scan: N repositories ...; discovery X ms, summaries Y ms (K read), total Z ms` (`Registry.doScan`) and `graph state <repo>: X ms (N commits)` (`GraphPanel.load`, up to just before the message is posted). In-editor numbers (extension host, file watchers) not measured: user check.
- The output channel moved to `src/util/log.ts` (`createLog(context)` returns the `log` function used everywhere; `showLog()` reveals the channel without taking focus) so the error reporter can reveal it without another command.
- Graph serializer: `registerWebviewPanelSerializer('gitsprout.graph')` hands the revived panel to `GraphPanel` (new optional constructor argument; it re-applies `webview.options`, which VS Code does not persist). A second revived panel is disposed (one graph tab). The executor's note that a revived panel loses `retainContextWhenHidden` was wrong (review): VS Code's webview editor serializer stores `{...webview.options, ...contentOptions}` with the tab and revives with them (checked in the VS Code 1.140 workbench bundle, `toJson`/`fromJson`), so the restored tab keeps it; re-applying `webview.options` is harmless. Review fix: until the first scan finishes (`Registry.scanned`, also set when the scan fails) an empty registry shows "Loading…" instead of "No Git repository in the workspace."; `onDidChangeRepos` then loads the graph. `onWebviewPanel:gitsprout.graph` added to `activationEvents`.
- "Run in Terminal": `terminal.sendText(cmd, false)`. "Show Command Output": new `ActionId` `output` (label as in the prototype), appended by `errorPlan` to every plan of `fetch`/`pull`/`push` except the "Publish Branch" prompt (NoUpstream is not a failure); other ops unchanged. The channel already holds kind, message and stderr of every failure. Unit tests in `test/commands.messages.test.ts`; plan assertions in `test/repo.integration.test.ts` updated.
- `registerStubCommands` left as is (registers nothing now; `COMMAND_IDS` stays in sync via the manifest test).
- Package: `.vscodeignore` got `!CHANGELOG.md`; `pnpm package` gives `gitsprout-0.1.0.vsix`, 10 files, 48.57 KB (not committed, `*.vsix` is ignored). vsce warns about a missing `repository` field and `LICENSE`: left as is (private, unpublished). Tests: 167 passing (+1).
- Not verified (user check, live VS Code/Cursor): installing the `.vsix` in both editors, the graph tab coming back after "Reload Window", "Show Command Output" and "Run in Terminal" (no Enter) in real notifications, in-editor timings, a day of work without GitKraken.

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

Work in /Users/fost/Projects/gitsprout. Task: repo discovery, registry, Repositories view, repo switching, status bar item, built-in SCM depth check, Fetch All — per stage 3 of roadmap-vscode.md. Repo (src/git/repo.ts) exists from stage 2; reuse it, open only what you edit. `Repo.summary()` returns only `SummaryStatus` (branch/sha/upstream/ahead/behind/changes); you fill `root/name/relPath/group` of `RepoSummary` (src/git/types.ts).

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
From the actual code (stage 3): `Registry` (src/workspace/registry.ts) has `active` (RepoSummary | undefined), `get(root)`, `gitPath`, `refreshRepo(root)` (serialised per repo; awaiting it returns state at least as new as your change) and events `onDidChangeActive(summary)` / `onDidChangeRepo(root)` / `onDidChangeRepos()`; create `new Repo(active.root, registry.gitPath)`. `activate()` in src/extension.ts skips `repositories` in the empty-tree loop (add your views there) and calls `registerStubCommands(context, REPO_COMMAND_IDS)` — extend that list (src/commands/repos.ts) or pass your own implemented ids when you replace stubs. `refresh`, `fetch`, `repoFetch`, `repoShowGraph`, `copyRepoPath` are already real. `Repo.stashFiles(i)` returns `StashFile[]` (`FileStat` + `untracked`), `Repo.show(ref, path)` takes ref `':'` for the index (a conflicted file yields stage 2, ours) and `''` for an empty side (src/git/repo.ts).

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
From the actual code (stage 4): the diff layer is `src/diff/uri.ts` (pure plans: `commitFilePlan(sha, file, parentSha)`, `unstagedPlan`, `stagedPlan(change, unborn)`) + `openPlan(root, plan)` in `src/diff/provider.ts` — the panel's `openCommitFile` / `openWipFile` handlers just build a plan and call it; no new diff code. Tree clicks fire `onReveal(sha)` (exported from `src/views/refsStore.ts`, internal command `gitsprout._revealCommit`): subscribe in `panel.ts` and post `reveal`. `Registry.onDidRefreshRepo(root)` fires after every repo read even when the summary is unchanged — use it (not `onDidChangeRepo`) to re-send `state`. Diff documents for non-sha refs (`:`, `HEAD`) already refresh on it; binary blobs render as a `Binary file …` placeholder.

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
From the actual code (stage 3): `refresh`, `fetch`, `repoFetch`, `fetchAll`, `repoShowGraph`, `copyRepoPath`, `switchRepository`, `toggleOnlyAttention` are already implemented in src/commands/repos.ts (`REPO_COMMAND_IDS`; `registerStubCommands(context, implemented)` skips them) — reuse `registry.refreshRepo(root)` after mutations and don't re-register those ids.

Already decided, don't ask: pull --no-rebase --no-edit; error → action mapping (PushRejected→Pull, NoUpstream→Publish Branch, Auth→Run in Terminal, Conflict→Open Source Control); every mutation refreshes the repo and the graph.
From the actual code (stage 2): `GitError` = { kind, message, stderr, stdout, args }; `args` already starts with `-C <root> -c core.quotePath=false`, so "Run in Terminal" can run `git` + args as is. `Repo.push()` publishes with `-u` itself when there is no upstream (so "Publish Branch" = `push()`); `createBranch` never tracks the start point. LocalChanges also comes from pull/stashApply/stashPop ("would be overwritten").
From the user (2026-10-03, stage 3 scope decision): Fetch All cancellation must also kill running `git fetch` processes — add an optional `signal: AbortSignal` (passed to `execFile`) and a `timeout` to `run()` in src/git/run.ts, thread it through `Repo.fetch`/`fetchAll`; a killed fetch reports as cancelled, not as an error. Unit-test that an aborted run rejects with a cancel kind.

From the actual code (stage 4): tree commands receive the tree node, not a string — branches `BranchLeaf` (`.branch.name`, `.isHead`), remotes `RemoteLeaf` (`.ref.name`), tags `Tag`, stashes `StashNode` (`.stash.index`, `.stash.sha`; the index may be stale — `stash apply/pop/drop` need `stash@{i}` (git refuses a bare sha for drop/pop), so re-resolve the index from `.stash.sha` via `repo.stashes()` right before running and fail with a message if it is gone), stash files `StashFileNode` (src/views/{branches,remotes,tags,stashes}.ts); graph rows pass `{sha}` via the webview context. `gitsprout.openStashFile` is already real (REF_COMMAND_IDS in src/commands/refs.ts) and `menus.commandPalette` already exists in package.json — append to it. After a mutation call `registry.refreshRepo(root)`: the trees reload on `onDidRefreshRepo`, no extra refresh needed.
From the actual code (stage 5): `copySha` and `copyMessage` are already implemented in src/graph/panel.ts (`GRAPH_COMMAND_IDS`, skipped by `registerStubCommands`; they read the commit from the open graph and accept `{sha}` or a bare sha — hide them from the palette, don't re-register them). `showGraph` / `toggleAutoBuild` are real too. The graph reloads itself on `Registry.onDidRefreshRepo`, so after a mutation `registry.refreshRepo(root)` is enough. `createBranchFrom` is wired to the graph row context menu (`webview/context`) and receives the row context `{ sha, webviewSection, … }` there (`shaFromArg` in src/graph/validate.ts normalises it), and the tree node from the trees. `gitsprout.hideCi` is written by the graph itself.
From the user (2026-10-04, stage 4 scope decision): keep auto-adding the parent repo of a workspace folder, but never climb to a repo whose root is the user's home directory (`os.homedir()`, dotfiles repo) — guard in `discoverWithParents` (src/workspace/discovery.ts), unit-test it.

From the user (2026-10-04, stage 5 scope decisions): (1) add a "Copy SHA" button to the commit details card as in the prototype — new `FromWebview` message `copy { text }` handled in src/graph/panel.ts via `vscode.env.clipboard`, button in `commitDetailsHtml`; (2) hide the repo chip in the graph toolbar when the window has a single repo — add `multiRepo: boolean` to `state` (src/graph/protocol.ts) and set `hidden` on `#repo` in webview/main.ts. Unit-test the message validation and the state flag.
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
From the actual code (stage 5): the graph `state` time is the body of `GraphPanel.load()` in src/graph/panel.ts (log + refs + status in parallel) — log it to the `Gitsprout` output channel there (the channel `log` function is already passed to `registerGraph`). The webview bundle emits `dist/webview.css` next to `dist/webview.js` (`.vscodeignore` already includes `dist/*.css`). README: mention the graph tab (⌥⌘G), `gitsprout.ciPattern` / `hideCi` / `logLimit` / `jira`.
From the user (2026-10-04, stage 5 scope decision): restore the graph tab after window reload — `registerWebviewPanelSerializer('gitsprout.graph')` (re-attach `GraphPanel` to the revived panel) + `onWebviewPanel:gitsprout.graph` in activationEvents. This is the one allowed addition to "no new features".
From the actual code (stage 6): all command ids are implemented now (`registerStubCommands` receives every id and registers nothing — leave it or delete it with its call, but keep `COMMAND_IDS` in sync with the manifest test). Mutations log failures to the `Gitsprout` output channel through the same `log`; README should mention the commands (Checkout…, Create Branch…, Stash…, Pull/Push/Fetch, Fetch All), that Pull is `--no-rebase`, and that a fetch is killed after 300 s in total (`FETCH_TIMEOUT_MS` in src/git/repo.ts). `run()` is built on `spawn` (not `execFile`) since stage 6 — killable calls run in their own process group; Pull/Push show a cancellable progress notification.
From the user (2026-10-04, stage 6 scope decisions): (1) "Run in Terminal" must type the failed command into the terminal WITHOUT pressing Enter (`terminal.sendText(cmd, false)`) — the user reviews and runs it; (2) add a "Show Command Output" action to git error notifications (at least push/pull/fetch errors, as in the prototype) that reveals the `Gitsprout` output channel (`errorPlan` action `output` → `channel.show()`). Unit-test the error plans. These two plus the graph panel serializer are the only allowed additions to "no new features".
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
- **Fetch vs. mutations in one repo.** The per-repo busy lock covers the stage 6 mutations only; a single-repo Fetch / Fetch All can overlap a Pull/Push in the same repo and fail on a ref lock (shown as an ordinary error). Share the lock if it shows up in practice.
- Open for the user: none blocking. Marketplace/Open VSX publishing, a file-status overlay in the Repositories view, reset/revert/cherry-pick are post-MVP.

## Order of work

Sequential, one repo: 1 → 2 → 3 → 4 → 5 → 6 → 7. Each stage ends with `/plan-review` (Opus): compare against this file, fix or document deviations, run "Done when", commit and push to `main`. User checks pile up in the acceptance reports and block only if they fail.
