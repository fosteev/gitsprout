# WIP panel: stage and commit from the graph (GitKraken-style)

> Status: stage 2 accepted 2026-10-04; next — stage 3 · created 2026-10-04 after the user approved the prototype. Executors tick checkboxes as they verify them; scope decisions and user checks go to `roadmap-wip-panel.pending.md` (same format as `roadmap-vscode.pending.md`).

## Goal

Selecting the WIP row in a graph tab opens a staging and commit panel in the details pane, as in GitKraken: unstaged and staged lists (Path/Tree), stage/unstage/discard per file and for everything, a commit summary (72-char counter) + description, Amend previous commit, Commit and Commit and Push. The user no longer has to switch to the built-in Source Control for the everyday commit.

## Context and constraints

- **Reference:** `prototype/vscode-multi.html`: `renderWip()`, `wipFiles()`, `wipCommit()`, the `/* WIP panel */` CSS block, and the `wip-*` cases in `actBase`. The published copy is https://claude.ai/artifact/DfowjjZp5VrKdf2xLHyx2k. Copy, labels and layout come from the prototype; the native parts (modals, notifications, diff editor) stay native.
- **Scope change, confirmed 2026-10-04.** The extension now stages, unstages, discards and commits. `README.md` (scope) and `CLAUDE.md` (Rules) were updated together with this roadmap. Conflict resolution, partial (hunk/line) staging, a merge editor and interactive rebase stay out of scope.
- **Rules:** `CLAUDE.md`. In short:
  - git only via `src/git/run.ts`;
  - pure parsers with literal fixtures;
  - protocol types live in `src/graph/protocol.ts`;
  - no runtime deps.
- **Contract and conventions:** `roadmap-vscode.md` ("Contract", "Webview protocol").
- **Already there; reuse, don't redo:**
  - `Repo.status()` + `parseStatus` (`src/git/repo.ts:73`, `src/git/parse.ts:56`). A partially staged file appears in both lists. Untracked = unstaged `A` with `untracked: true`; conflicted = unstaged `U`.
  - WIP file diffs: `openWipFile` → `unstagedPlan`/`stagedPlan` (`src/diff/uri.ts:66,73`, `src/graph/panel.ts:190`).
  - The mutation plumbing: `Mutator {target, mutate, fail}` (`src/commands/mutations.ts:23-77`; `mutate` serialises per repo, refreshes, and routes errors through `errorPlan`). Plus `Op`/`errorPlan` (`src/commands/messages.ts:176`).
  - The Push command `gitsprout.push` takes a root (`src/commands/mutations.ts:92`).
  - `Repo.isOnRemote(sha)`.
- **Webview today:**
  - `webview/main.ts` holds module-level globals.
  - `renderDetails()` (`main.ts:105`) rewrites `details.innerHTML` on every `state` message.
  - The WIP branch calls `wipDetailsHtml` (`webview/render.ts:147`), a flat list with an "Open Source Control" button.
  - Only `setState({root})` is persisted (`main.ts:185`; the panel serializer reads it, `panel.ts:276`).
  - `panel.ts:141` skips identical `state` posts.
- **Refresh today:** the registry watches only the git dir (`src/workspace/registry.ts:10`, debounce 300 ms) plus window focus. Index changes (stage/unstage) refresh quickly. **Working-tree edits don't**, which a staging panel can't live with (stage 2 adds a watcher).

### Decisions (taken; don't revisit without the user)

- **Git calls.** Each comes with an integration test.
  - **Stage** = `git --literal-pathspecs add -A -- <paths>`. Untracked, deleted and conflicted files are all handled; for `U` this means "mark resolved".
  - **Stage All** = `git add -A`.
  - **Unstage** = `git --literal-pathspecs reset -q -- <paths>`. A rename passes both `origPath` and `path`. Assumption: this works on an unborn branch (git ≥ 1.8.2); the test proves it.
  - **Unstage All** = `git reset -q`.
  - **Discard file** (unstaged rows only, not on `U`):
    - tracked: `git --literal-pathspecs restore --worktree -- <path>` (restores from the index, so a partly staged file keeps its staged part);
    - untracked: `git --literal-pathspecs clean -f -q -- <path>`.
  - **Discard All** = `git reset --hard -q` + `git clean -fd -q`. Ignored files stay. On an unborn branch show the info message "Nothing to discard to: the branch has no commits yet."
  - **Commit** = `git commit --cleanup=whitespace -F -`, with the message on stdin (`RunOptions.stdin`) and `--amend` when amending. Hooks run (they are the user's). `-F` means no editor. Signing follows the user's config.
- **Message** = `summary.trim()` + (description.trim() ? `\n\n` + description.trim() : ''). An empty summary → inline error "Enter a commit summary." and no git call. The counter shows 72 − length and turns red below 0; it never blocks.
- **Primary button**, as in the prototype:
  - Amend checked → "Amend Previous Commit".
  - Staged > 0 → "Commit Changes to N File(s)".
  - Otherwise → "Stage Changes to Commit", which runs Stage All and does not commit.
  - The ▾ menu has "Commit and Push" only when not amending (no force push in the extension).
- **Amend toggle.**
  - On with an empty draft → prefill summary/description from HEAD (`git log -1 --format=%B`; the first line is the summary, the rest the description — changed at the stage 1 review from "split at the first blank line", see there).
  - Off while the draft still equals HEAD's message → clear it.
  - If HEAD is already on a remote (`isOnRemote`) → muted note under the checkbox: "HEAD is already pushed. Amending rewrites it; pushing will need --force."
  - Disabled on an unborn branch.
- **Confirmations.** Native modals (`showWarningMessage({modal: true})`), shown by the extension, not the webview.
  - Discard file: "Discard changes in 'x'?" / detail "This can't be undone." (untracked: "The file will be deleted. This can't be undone."). Button "Discard".
  - Discard All: "Discard all changes in N files?" / detail "Staged and unstaged changes are reset to HEAD and untracked files are deleted. This can't be undone." Button "Discard All".
  - Stage, unstage and commit need no confirmation.
- **Progress.**
  - Commit (hooks can be slow) → progress notification "Committing…" with Cancel, via `mutate(..., progress)`.
  - Success → status-bar flash "Committed abc1234" (no notification).
  - Commit and Push → after a successful commit, `executeCommand('gitsprout.push', root)`, i.e. the existing push flow with its errors and buttons.
  - Stage/unstage/discard: no progress UI.
- **Errors.**
  - New `Op` values: `stage | unstage | discard | commit`.
  - A commit failing with kind `Other` (a hook rejected it, nothing to commit, a GPG error) → error notification "Commit failed: <last stderr line>" + "Show Command Output". **The draft is kept.**
- **Busy.** While a WIP op is in flight, the webview disables every WIP button. A new ToWebview message `{type: 'wipBusy', on}` carries this, separate from the loading `busy`. `mutate`'s per-repo guard stays as the backstop.
- **Draft persistence.** Per graph tab (= per repo): `{summary, description, amend}`, the Path/Tree view and collapsed folders go into `vscode.setState` together with `root`. Restored on load and after a window reload. Cleared only by a successful commit (ToWebview `{type: 'committed'}`).
- **Re-render rule.** Every `state` re-renders the file lists. The commit box (inputs) is built once per WIP selection and only patched: button label/disabled, counter, amend note. Focus, caret and typed text survive a `state` message.
- **Working-tree watcher.** One `FileSystemWatcher(new RelativePattern(root, '**'))` per **open** graph panel, ignoring paths under the git dir. Any event → the registry's debounced `refreshRepo(root)`. Disposed with the panel. VS Code's `files.watcherExclude` (node_modules etc.) applies.
- **Tree view.** Folders with a single child folder and no files are compacted (`pulse/widgets`), like VS Code's compact folders. The default view is Tree. "Collapse All"/"Expand All" act on that list's folders.
- **No new palette commands.** Everything is driven from the webview. The "Open Source Control" button disappears; the `gitsprout.openSourceControl` command stays.
- **Not in this roadmap:**
  - hunk/line staging;
  - multi-select of rows;
  - right-click menus on file rows;
  - stash from the panel (the Stashes tree has it);
  - a merge-message prefill (`MERGE_MSG`);
  - AI compose;
  - the WIP row shown when the tree is clean.

## Stages

### 1. Git layer

`Repo` gets the WIP operations, each pinned by integration tests on temp repos.

- [x] `src/git/repo.ts`: `stage(files: FileChange[])`, `stageAll()`, `unstage(files: FileChange[])`, `unstageAll()`, `discard(file: FileChange)`, `discardAll()`, `commit(message: string, opts: {amend: boolean; signal?: AbortSignal})`, `headMessage(): {summary, description} | null` (null when unborn). The exact git calls are in Decisions. `--literal-pathspecs` goes before the subcommand. Paths come from `FileChange` (`origPath` too for a staged rename)
- [x] pure `commitMessage(summary, description): string | null` (null = empty summary) and `splitMessage(body): {summary, description}`, next to the other pure helpers (`src/git/parse.ts` or a new `src/git/message.ts`), with literal-fixture unit tests (trailing spaces, CRLF, a description without a summary, a multi-paragraph body)
- [x] `src/commands/messages.ts`: `Op` += `'stage' | 'unstage' | 'discard' | 'commit'`; `errorPlan` gives `commit` + `Other` → "Commit failed: <message>" + Show Command Output; the others get the generic text
- [x] integration tests (style of `test/repo.integration.test.ts`):
  - stage modified/untracked/deleted, plus a file named `-x` and one named `a*b.txt` (literal pathspecs);
  - unstage on a normal and an **unborn** branch, and a staged rename (both sides end up unstaged);
  - discard tracked (the staged part of a partially staged file survives) and untracked;
  - discardAll (ignored file survives);
  - commit with a two-paragraph message (`git log -1 --format=%B` matches);
  - amend (message replaced, parent unchanged);
  - a `pre-commit` hook that exits 1 → `GitError`, no commit, stderr kept;
  - `headMessage` on unborn → null

**Done when:** `pnpm typecheck && pnpm test` green; every bullet above is a passing test.

**Session:** sonnet, high; first.

**Decisions (2026-10-04, session 1):**

- **Layout.** WIP methods are appended to `Repo` in `src/git/repo.ts` (section "WIP: stage, unstage, discard, commit"). The pure helpers live in the new `src/git/message.ts`. `Op` and `errorPlan` are in `src/commands/messages.ts`. Tests: `test/repo.integration.test.ts` (new `describe('WIP: ...')`), `test/parse.test.ts` (message helpers), `test/commands.messages.test.ts` (errorPlan).
- **Contract (Repo).**
  - `stage(files: FileChange[]): Promise<void>`, `unstage(files: FileChange[]): Promise<void>`: an empty list is a no-op; paths = `path` plus `origPath` (deduplicated).
  - `stageAll()`, `unstageAll()`: `Promise<void>`.
  - `discard(file: FileChange): Promise<void>`: untracked uses `clean`, tracked uses `restore --worktree`; intent-to-add (unstaged `A`/`R`, not untracked) uses `reset` + `clean` (+ `restore --worktree origPath` for `R`), i.e. the file is deleted; a `U` file and a nested repository (path ends with `/`) throw `GitError('Other')`.
  - `discardAll(): Promise<void>`: **throws `GitError('Other', 'Nothing to discard to: the branch has no commits yet.')` on an unborn branch** (backstop; stage 2 should check `headMessage() === null` first and show the info message instead).
  - `commit(message: string, opts: {amend: boolean; signal?: AbortSignal}): Promise<string>`: `commit --cleanup=whitespace -F -` with the message on stdin, plus `--amend`; returns the new HEAD sha. A cancel after the commit was made (slow post-commit hook) resolves with the new sha instead of rejecting `Cancelled`.
  - `headMessage(): Promise<{summary, description} | null>`: null when unborn.
  - Pure (`src/git/message.ts`): `commitMessage(summary, description): string | null` (trim, CRLF to LF, null on an empty summary) and `splitMessage(body): {summary, description}` (summary = the first line, description = the rest, trimmed).
- **Errors.** `Op` += `stage | unstage | discard | commit`. `errorPlan(commit, …)` returns "Commit failed: <git's last line>" with actions `['output']` for any kind but Cancelled (a hook's text may classify as `Auth`/`NotARepo`); Cancelled returns null; the other new ops use the generic "<Op> failed: ...". A hook failure and "nothing to commit" both come out as kind `Other` (stderr/stdout kept on the `GitError`).
- **Deviations.** None. The unborn-branch assumption (`git reset -q -- paths` and `git reset -q` work with no HEAD) holds on the local git; the `git rm --cached` fallback was not needed.
- **Notes for stage 2.** `discard` takes a single file; the modal text "The file will be deleted…" is for `file.untracked` **and** for an intent-to-add row (unstaged `A`/`R`), tracked otherwise; a nested repository row (`path` ends with `/`) gets no Discard (it would only fail). `committed {sha}` and the "Committed abc1234" flash take the sha `Repo.commit` returns. `Repo.commit` does not check for an empty message; the caller uses `commitMessage` (null means no git call).
- **Not verified.** Only the local git version (2.49 in the temp-repo tests); older git (< 2.23, no `restore`) is not covered. Signing/GPG failures are not tested (no key in the test env).

**Review (2026-10-04, stage 1 accepted).** Tests added at review: paths with spaces, a leading `:` and non-ASCII (stage/unstage/discard); stage on a real merge conflict (`U` → resolved, the merge commit takes our message, `headMessage` on a merge commit); amend with nothing staged (message only, tree unchanged); a commit cancelled during a slow pre-commit hook (`Cancelled`, no commit, no `index.lock` left). Fixed at review (found by the second pass, each with a test): discard of an intent-to-add file truncated it to the empty index blob, and of an unstaged rename left both sides broken; discard of a nested repository was a silent no-op (now refused); Cancel during a slow post-commit hook reported `Cancelled` although the commit existed, so a retry would commit or amend twice (now success when HEAD moved); `splitMessage` put a multi-line first paragraph into the single-line summary (amend prefill would glue the lines); a commit failure classified as `Auth`/`NotARepo` lost Show Command Output; the output channel now logs git's stdout too (`nothing to commit` is there). Left as is: untracked discard leaves empty parent folders (git doesn't show them); staging a path that vanished since the last status fails with git's `pathspec did not match` (a refresh follows).

### 2. Protocol and extension wiring

The panel accepts the WIP messages and runs them through the mutator, with modals, busy and the working-tree watcher.

- [x] `src/graph/protocol.ts`:
  - FromWebview += `stage {files: FileChange[]}`, `stageAll {}`, `unstage {files: FileChange[]}`, `unstageAll {}`, `discard {file: FileChange}`, `discardAll {}`, `commit {summary: string; description: string; amend: boolean; push: boolean}`, `amendInfo {}`;
  - ToWebview += `wipBusy {on}`, `committed {sha}`, `amendInfo {summary, description, pushed: boolean} | {unborn: true}`
- [x] `src/graph/validate.ts`: cases for each new message (`asFileChange` + `isSafeRelPath` for files; strings capped at 64 KB; booleans checked); unit tests in `test/graph.render.test.ts` (or a new `test/graph.validate.test.ts`) for good and bad shapes
- [x] new `src/commands/wip.ts`: `createWipActions(registry, log, mutator)` → `{stage, stageAll, unstage, unstageAll, discard, discardAll, commit, amendInfo}`, each taking `root`. Files are re-checked against a fresh `repo.status()` (only files that are still in the list are acted on). Modals, progress, flash and push are as in Decisions; it returns whether the op succeeded
- [x] `src/graph/panel.ts`: `handle` cases call the actions with `this.repoRoot`; post `wipBusy` on/off around each; after a successful commit post `committed`; the actions object is injected through `show()`/the serializer (wire in `src/extension.ts`)
- [x] working-tree watcher per open panel (Decisions), disposed in the panel's `dispose`; a unit-free check: an F5 note in the pending file (the live check itself is **user**)
- [x] `roadmap-vscode.md`: the Staging/commit row in the Decisions table → "WIP panel in the graph (see `roadmap-wip-panel.md`)"; the protocol listing gets the new messages

**Done when:** `pnpm typecheck && pnpm test` green; `pnpm build` ok; validate tests cover every new message type.

**Session:** sonnet, high; after stage 1.

**Decisions (2026-10-04, session 2):**

- **Layout.**
  - `src/commands/wip.ts` (new): `createWipActions(registry, log, mutator): WipActions`, the only module that runs WIP git ops. It imports `vscode`, so it has no unit tests; its pure parts are in `src/commands/messages.ts` (section "WIP panel": `matchFiles`, `changedFileCount`, `discardDeletes`, `discardFileConfirm`, `discardAllConfirm`, `committedFlash`, the texts `NOTHING_TO_DISCARD_TO`, `NO_COMMIT_SUMMARY`, `NESTED_REPO_DISCARD`) and tested in `test/commands.messages.test.ts`.
  - `src/graph/protocol.ts`, `src/graph/validate.ts` (new `inGitDir`, `MAX_COMMIT_TEXT`, `MAX_FILES`); tests in the new `test/graph.validate.test.ts`.
  - `src/graph/panel.ts`: `handle` cases, `withWipBusy`, the watcher. `src/workspace/registry.ts`: `schedule(root)` made public (was private) for the watcher.
- **Protocol.**
  - FromWebview: `stage {files}`, `unstage {files}` (1..10000 `FileChange`, each through `asFileChange`; an empty list is rejected), `stageAll`, `unstageAll`, `discardAll`, `amendInfo` (no fields), `discard {file}`, `commit {summary, description, amend, push}` (strings up to 64K UTF-16 units each, booleans checked; an empty summary passes validation, the action refuses it).
  - ToWebview: `wipBusy {on}`, `committed {sha}`, `amendInfo` = `{summary, description, pushed}` or `{unborn: true}`. `amendInfo` is a request/answer pair sharing one type name; the webview tells the direction by where it came from. The answer is not wrapped in `wipBusy` (read-only). No answer is posted when HEAD can't be read (a log line only).
- **Actions injection.** `registerGraph(context, registry, log, wip)` takes the `WipActions` object; `extension.ts` builds it from the mutator returned by `registerMutations`. The serializer and `show()` pass the same object to each `GraphPanel`. Actions take `root` (the tab's `repoRoot`), so a tab never acts on another repo.
- **Action contract.**
  - `stage/unstage/stageAll/unstageAll/discard/discardAll` return `Promise<boolean>` (did the job; refusal, cancel and failure are `false` and are already shown). `commit` returns `Promise<string | undefined>`, the new HEAD sha (the panel needs it for `committed`); the other end of the contract is unchanged. `amendInfo` returns the `amendInfo` message or undefined.
  - `stage`/`unstage`/`discard` read a fresh `status()` and act on the extension's **own** entries that match the request by `path` + `origPath`; none left (stale list) → `false` and `refreshRepo`. Stage All / Unstage All take no list (`add -A`, `reset`).
  - `discard`: a `U` row or a vanished file → `false` + refresh (the webview must not offer Discard on `U`); a nested repository row (`path` ends with `/`) → info message, no git call; else the modal ("Discard changes in 'x'?", detail varies for untracked/intent-to-add via `discardDeletes`) then `mutate('discard')`.
  - `discardAll`: unborn check (`headMessage() === null`) first → info "Nothing to discard to: the branch has no commits yet." (before the modal); N = distinct changed paths (a partly staged file counts once); N = 0 → refresh and `false`; modal; `mutate('discard')`.
  - `commit`: `commitMessage` null → warning "Enter a commit summary." (backstop; the webview shows it inline) and no git call. Else `mutate(t, 'commit', …, 'Committing…')` (progress with Cancel); success → status-bar flash "Committed abc1234", return sha. `push && !amend` → `executeCommand('gitsprout.push', root)` fired **without awaiting**, so the panel does not stay `wipBusy` for a push; push has its own progress and error buttons. `push` together with `amend` is ignored (no force push in the extension; the webview doesn't offer it).
  - Failure of a commit: `mutate` shows `errorPlan('commit')`; nothing is posted, so the webview keeps the draft.
- **Panel.** `withWipBusy` counts running WIP ops: `wipBusy {on:true}` on the first, `{on:false}` after the last (a backstop; the webview also disables its buttons). `committed {sha}` is posted after `commit` resolves with a sha, i.e. after `mutate`'s refresh has queued the `state` reload. A `state` message may therefore arrive slightly before or after `committed`; the webview must not depend on the order.
- **Watcher.** One `createFileSystemWatcher(new RelativePattern(repoRoot, '**'))` per `GraphPanel`, pushed into the panel's disposables (disposed with the tab, so it lives only while the tab is open, hidden or not). Any create/change/delete outside a `.git` folder (`inGitDir`, so also a nested repo's or submodule's `.git`) → `registry.schedule(repoRoot)` (the existing 300 ms debounce, then `refreshRepo`). Events while the tab is hidden still schedule a refresh; the hidden panel then just marks itself `dirty` (existing behaviour). A linked worktree's git dir lies outside the root and is watched by the registry itself.
- **Deviations.** (1) `commit` returns the sha, not a boolean (above). (2) `amendInfo` uses `refs().head.sha` for `isOnRemote` rather than exposing the private `headSha`. (3) The pure helpers went to `messages.ts` (not `wip.ts`) so they can be unit-tested without `vscode`.
- **Scope.** None beyond the roadmap; the "backstop" warning for an empty summary is user-visible only if the webview misbehaves.
- **For stage 3.** The webview sends the new messages exactly as typed; it must (a) not offer Discard on `U` rows or on rows whose `path` ends with `/`, (b) treat `amendInfo` from the extension as `{summary, description, pushed}` or `{unborn: true}` and fill the draft only when the draft is still empty/unchanged, (c) clear the draft on `committed` and keep it otherwise, (d) not send `push: true` with `amend: true`. For the "Commit" button with nothing staged the webview sends `stageAll` (not `commit`). (e) send one file per row action (`stage`/`unstage` with a single-entry list); there is no folder-level stage/unstage in this roadmap, and a list of thousands of paths would overflow the command line (see Risks). (f) Paths containing a `.git` segment or starting with `\` are rejected by `validate.ts` (git never lists them).
- **Not verified.** No live run: the panel wiring, modals, progress notification, the status-bar flash, `Commit and Push` and the watcher were not exercised in a real VS Code (no F5; there is no UI yet to send the messages). `wip.ts` has no automated tests (imports `vscode`); the `Repo` calls it makes are covered by stage 1's integration tests, its decision logic by the pure helpers' tests. The ordering of `committed` and `state` was reasoned, not observed.

**Review (2026-10-04, stage 2 accepted).** Fixed at review (the first two found by the second pass):
- Cancel during a slow post-commit hook with Commit and Push: the commit stands (stage 1 semantics) but the push no longer starts (`signal.aborted` after `Repo.commit`); the push also needs the root still registered (`gitsprout.push` falls back to the active repo for an unknown root).
- `Registry.schedule` was a pure trailing debounce, so the new `**` watcher under a steady stream of events (a dev server writing a log in the tree, gitignored or not) starved every refresh of that repo, including the git-dir ones. It now fires at most `MAX_WAIT_MS` (2 s) after the first pending event.
- `discard` re-reads `status()` inside the `mutate` work and skips (returns false, refresh) when the row vanished, became `U`, or changed between "deleted" and "restored" while the modal was open.
- `matchFiles` keys on a `Set` (was O(requested × status)).
- `isSafeRelPath` also rejects a `.git` segment (case-insensitive) and a leading `\`; the watcher tests `inGitDir` on the path relative to the root (an absolute root containing a `.git` segment ignored every event). Tests in `test/graph.validate.test.ts`.

Left as is: the watcher is created even when a restored tab's root is not (yet) in the registry (the registry may finish discovery after the serializer runs; `schedule` ignores unknown roots); amend on an unborn branch is refused by git ("Commit failed: … nothing to amend") rather than by the action (the webview disables the checkbox); Discard All's N counts a nested repo's `dir/` row, which `clean -fd` keeps; argv length for huge `stage`/`unstage` lists (Risks).

### 3. Webview panel

The details pane renders the prototype's panel; a DOM smoke test pins the re-render rule.

- [ ] pure `webview/wipTree.ts`: `buildTree(files): TreeNode` with folder compaction + stable sort (folders first, then files, by name); unit tests with literal fixtures (`pulse/widgets/a.php`, a root-level `.DS_Store`, a single-child chain, the same path in both areas)
- [ ] `webview/render.ts`: replace `wipDetailsHtml` with builders ported from the prototype: `wipHeaderHtml(n, branch)`, `wipListsHtml(wip, view, collapsed)` (sections, Stage All / Unstage All, row actions open/discard/stage or unstage, letters, empty texts) and `wipCommitHtml(draft, ctx)` (amend checkbox + note, summary input with counter, description, primary button + ▾ per Decisions). Unit tests: escaping of paths, button label per state, no discard on `U` rows, Stage All hidden on an empty list
- [ ] `webview/main.ts`:
  - **WIP layout.** WIP selected → the details pane holds the header, `#wip-lists` (re-rendered on every `state`) and `#wip-commit` (built once per WIP selection, patched afterwards).
  - **Clicks** (delegated) post the stage 2 messages.
  - **Keys:** ⌘/Ctrl+Enter in summary/description = primary action.
  - **Draft and view state** go to `setState` (merged with `root`) and are restored on load.
  - **Server messages:** `committed` clears the draft; `wipBusy` disables WIP buttons; `amendInfo` fills the draft.
  - **WIP row label:** the graph's WIP row shows the draft summary when one is set, else `// WIP`, plus the file count (prototype `renderGraph`).
- [ ] `webview/styles.css`: port the prototype's `/* WIP panel */` block onto VS Code theme variables (`--vscode-*`, as the rest of the file does); the details column is 380 px while WIP is selected (prototype `.split.wipon`)
- [ ] DOM smoke test (devDependency `happy-dom`, or `jsdom` if it fits better; the file uses `// @vitest-environment happy-dom`). Stub `acquireVsCodeApi`, load `webview/main.ts`, then:
  - post a `state` with WIP and select WIP;
  - type a summary, then post another `state` → the input value and focus survive;
  - click stage on a row → a `stage` message is posted with that file;
  - click the primary button with an empty summary → error shown, no `commit` posted;
  - post `committed` → draft cleared
- [ ] `README.md` Usage gets a short WIP-panel paragraph; `CHANGELOG.md` gets an "Unreleased" entry; `roadmap-wip-panel.pending.md` lists the user's checks (below)

**Done when:** `pnpm typecheck && pnpm test` green (incl. the smoke test); `pnpm build` ok; `pnpm package` builds the `.vsix`.

**Session:** sonnet, high; after stage 2. Opus acceptance with extra care on `main.ts`.

**User checks (to the pending file):**
- F5:
  - stage/unstage/discard a file and everything;
  - Path/Tree, Collapse All;
  - a commit with a pre-commit hook in a real repo (Pilot7 if it has one);
  - Commit and Push;
  - amend on a pushed HEAD (the note shows);
  - the draft survives switching tabs and a window reload;
  - a file saved in the editor appears in Unstaged within ~1 s;
  - light and dark themes.

## Session prompts

Common to all stages:
- Work in `/Users/fost/Projects/gitsprout`, under the rules in `CLAUDE.md`.
- This file is the plan: the stage section + "Context and constraints" + "Decisions".
- Don't commit or push.
- Last message = report: done (files) / deviations / not verified / open questions.

### Stage 1
```
Session 1 — Gitsprout WIP panel: git layer · Model: sonnet, effort: high · first

Work in /Users/fost/Projects/gitsprout. Task: stage 1 of roadmap-wip-panel.md (Repo stage/unstage/discard/commit/headMessage, commit message helpers, Op/errorPlan, integration tests).

Read: roadmap-wip-panel.md (Context, Decisions, stage 1); CLAUDE.md. Entry points: src/git/repo.ts:30 private git() + rule lists, :73 status, :242 reset, :284 cherryPick (pattern for a commit-creating op), :406 stashPush; src/git/run.ts (RunOptions.stdin, signal); src/git/types.ts:34 FileChange, :4 GitError; src/commands/messages.ts:176 Op + errorPlan; test/repo.integration.test.ts:1-50 (temp repo env and helpers g/put/commit).
Entry points were verified while planning — open only the fragment you edit.

Already decided: everything under "Decisions" in the roadmap.
Order: stage 1 checkboxes top to bottom; tick a box only after its check passes. Write the unborn-branch and literal-pathspec tests first.
DoD: pnpm typecheck && pnpm test green. Long output to a log file, only the tail into context.
Don't: protocol/webview/panel changes, new runtime deps. A question the roadmap does not answer → report + roadmap-wip-panel.pending.md.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

### Stage 2
```
Session 2 — Gitsprout WIP panel: protocol and extension wiring · Model: sonnet, effort: high · after stage 1 is accepted

Work in /Users/fost/Projects/gitsprout. Task: stage 2 of roadmap-wip-panel.md.

Read: roadmap-wip-panel.md (Decisions, stage 2, and stage 1's "Decisions (2026-10-04, session 1)" — the Repo contract you call); CLAUDE.md. Before Discard All, check `repo.headMessage() === null` and show the info message "Nothing to discard to: the branch has no commits yet." yourself (`Repo.discardAll()` throws `GitError('Other')` on an unborn branch only as a backstop). Entry points: src/graph/protocol.ts (FromWebview/ToWebview); src/graph/validate.ts:9 isSafeRelPath, :23 asFileChange, :35 parseFromWebview; src/graph/panel.ts:110 load, :154 onMessage, :165 handle, :190 openWipFile (re-check pattern), :238 panels map + show(), :276 serializer; src/commands/mutations.ts:23-77 Mutator/mutate (progress + signal), :92 push; src/commands/commits.ts (pattern: a module that takes the Mutator; modal confirm examples at :61, :147); src/workspace/registry.ts:144-161 watch/schedule, refreshRepo; src/extension.ts wiring.

Order: stage 2 checkboxes top to bottom; tick after checks.
DoD: pnpm typecheck && pnpm test green, pnpm build ok.
Don't: webview UI (stage 3), new palette commands. Unanswered questions → report + pending file.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

### Stage 3
```
Session 3 — Gitsprout WIP panel: webview · Model: sonnet, effort: high · after stage 2 is accepted

Work in /Users/fost/Projects/gitsprout. Task: stage 3 of roadmap-wip-panel.md.

Read: roadmap-wip-panel.md (Decisions — especially "Re-render rule" and "Draft persistence", stage 3, and stage 2's "Decisions (2026-10-04, session 2)" incl. "For stage 3" — the exact protocol); CLAUDE.md. Reference UI: prototype/vscode-multi.html — renderWip(), wipFiles(), wipCommit(), the `/* WIP panel */` CSS block, the wip-* cases in actBase, the 'wsum'/'wdesc' input handlers. Entry points: webview/main.ts:12 acquireVsCodeApi typing, :35-44 globals, :105 renderDetails, :162 onState, :185 setState, :216 details click delegation; webview/render.ts:98 fileRow, :147 wipDetailsHtml (replace); webview/format.ts splitPath; webview/styles.css (theme variables); test/graph.render.test.ts (style); vitest config for the per-file environment.

Order: stage 3 checkboxes top to bottom; tick after checks. Write the DOM smoke test before reworking main.ts.
DoD: pnpm typecheck && pnpm test green (incl. the smoke test), pnpm build ok, pnpm package builds the .vsix.
Don't: hunk staging, multi-select, file-row context menus, runtime deps (happy-dom/jsdom only as a devDependency). Unanswered questions → report + pending file.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

## Risks and open questions

- **Hooks and signing.**
  - A slow pre-commit hook (lint, tests) blocks the commit; progress with Cancel covers it. Cancel kills git, which leaves no partial commit.
  - GPG with a TTY-only pinentry fails under `GIT_TERMINAL_PROMPT=0` and no TTY. That surfaces as "Commit failed: …" plus Show Command Output, the same limitation as the built-in Git. Not solved here.
- **Watcher load.** A `**` watcher per open graph tab costs VS Code watcher resources in huge repos. There is only one per *open* tab and `files.watcherExclude` applies. If it's still a problem: watch only while the tab is visible (the panel already tracks visibility for `dirty`).
- **Unborn branch.** The `reset` behaviour for unstage is an assumption until stage 1's test passes. Fallback: `git rm --cached -r -q -- <paths>` when HEAD is unborn.
- **Discard is destructive.**
  - Untracked files deleted by `clean` aren't recoverable; only the modal protects them.
  - Stashing before discarding would make the op recoverable but noisier. Rejected for now; revisit if the user asks.
- **Long path lists.** `Repo.stage`/`unstage` put every path into one argv; `validate.ts` allows up to 10 000 files. Windows caps a command line at ~32K chars, so a few hundred deep paths would fail (`ENAMETOOLONG`). Harmless while the webview sends one file per row action (stage 3); if folder or multi-select staging ever comes, pass paths via `--pathspec-from-file=- --pathspec-file-nul` on stdin (git ≥ 2.25) or chunk them.
- **Webview re-render.** The commit box must survive `state` messages; the stage 3 smoke test guards it. Without that test, a regression shows up only as "my text disappeared".
- **`isOnRemote` on every amend toggle** runs `git branch -r --contains`, which is fine for one call per toggle. It is not done on every state.

## Order of work

Strictly sequential, one repo: 1 → 2 → 3, each accepted (`/plan-review`) and merged before the next.
