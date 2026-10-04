# Git actions from GitKraken's context menus (batch 1)

> Status: in progress · 2026-10-04 · stages 1–4 accepted (UI checks in the pending file); stage 5 (detached HEAD) waits for the user. Executors tick checkboxes as they verify them; scope decisions and user checks go to `roadmap-git-actions.pending.md` (same format as `roadmap-vscode.pending.md`).

## Goal

The graph's commit context menu and the ref trees offer the cheap GitKraken actions that Gitsprout lacks: tags, remote links, Set Upstream, Reset ▸, Cherry Pick, Revert, Compare with Working Tree, Save as Patch. Each one is a single git call through `Repo` + the existing mutate/error plumbing, unit-tested, plus integration tests on temp repos.

## Context and constraints

- Rules: `CLAUDE.md` (git only via `src/git/run.ts`, pure parsers with literal fixtures, no runtime deps, protocol types shared). MVP scope: `README.md`; contract and conventions: `roadmap-vscode.md` ("Contract", "Decisions").
- Already there (do not redo): Pull, Push, Create Branch Here (`createBranchFrom` on graph rows), Rename/Delete branch, Copy Commit SHA/Message, Copy Branch Name (trees).
- Graph tabs are one per repo (`roadmap-vscode.md` → "Graph tab per repo"); focusing a tab makes its repo active. Commands fired from a graph row must still act on **that row's repo**, not on whatever is active — hence `root` in the row context (stage 1).
- Mutations live in `src/commands/mutations.ts` (`registerMutations`: `target()`, `mutate()` serialised per repo + refresh + `errorPlan`, `fail`). Error texts/actions: `src/commands/messages.ts` (`Op`, `errorPlan`, `branchNameError`). Git ops: `src/git/repo.ts` (rule lists `LOCAL_CHANGES`, `CONFLICT`, `PUSH_REJECTED`, `READ` opts, `--end-of-options` everywhere a ref comes from the user/trees).
- Every new command: id in `COMMAND_IDS` (`src/commands/ids.ts`) + `contributes.commands` + menus + `commandPalette: when false` for context-only ones; `test/manifest.test.ts` enforces consistency. Implemented ids must be passed to `registerStubCommands` (`src/extension.ts:25`).

### Decisions (taken; don't revisit without the user)

- **Cherry Pick and Revert are allowed to create commits.** The "extension never stages or commits" rule is about a staging/commit UI; these are git operations like Pull's merge commit. Conflicts are left to the built-in Source Control (commit there continues the operation). Record this as a confirmed `[scope]` line in the pending file and add one sentence to `CLAUDE.md` → Rules: "Cherry-pick/revert/reset may create or move commits; there is still no staging or commit UI."
- Reset acts on the **current branch only** (`git reset --soft|--mixed|--hard <sha>`); detached HEAD → information message. Hard reset → modal confirmation; soft/mixed → none (the changes stay in the working tree).
- Merge commits: Revert and Cherry Pick use `-m 1`; Save as Patch on a merge → information message (format-patch emits nothing).
- Tags get Delete and Push too (a tag that cannot be pushed is half a feature). Push Tag remote: `remote.pushDefault` → `origin` → first remote.
- Remote web links: GitHub (`github.com` or a host containing `github`) → `/commit/<sha>`, `/tree/<branch>`; Bitbucket (`bitbucket.org`) → `/commits/<sha>`, `/branch/<branch>`; anything else is treated as GitLab (self-hosted `gitlab.pilot-gps.com`, …) → `/-/commit/<sha>`, `/-/tree/<branch>`.
- Not in this batch: Checkout this commit (detached HEAD, stage 5, optional), Rebase onto, Edit message, Drop, Worktrees, Hide/Solo, PR/AI/Cloud items, Apply patch.

## Stages

### 1. Plumbing and tags

Row context carries the repo; mutations helpers become reusable from a new module; tag commands.

- [x] `webview/render.ts` `commitContext(sha, root)` → `{ webviewSection: 'commit', sha, root, preventDefaultContextMenuItems: true }` (update `CommitContext` type and `RowEnv`/callers, the root comes from the last `state.repo.root`); unit test in `test/graph.render.test.ts`
- [x] `src/commands/messages.ts`: `rootFromArg(arg): string | undefined` (string field `root` of an object); `registerMutations` → `target(rootFromArg(arg))` for the graph-row commands (`createBranchFrom` with a sha) so they act on the row's repo; existing notification-button `root` strings keep working
- [x] `registerMutations` returns `{ target, mutate, fail }` (type `Mutator`, exported); new commands live in `src/commands/commits.ts` → `registerCommitCommands(context, registry, log, mutator)` with `COMMIT_COMMAND_IDS`, wired in `src/extension.ts` and passed to `registerStubCommands`
- [x] `Op` += `'tag' | 'reset' | 'cherryPick' | 'revert' | 'upstream'`; `errorPlan` gives them sensible texts (`Conflict` → "Open Source Control"; `pushTag` errors go through the `push` op so Auth/Run in Terminal/Show Command Output work)
- [x] `Repo.createTag(name, sha, message?)` (`check-ref-format refs/tags/<name>` first, then `git tag [-a -m <message>] --end-of-options <name> <sha>`), `Repo.deleteTag(name)` (`git tag -d --end-of-options`), `Repo.pushTag(name, {signal})` (`git push <remote> refs/tags/<name>`, remote per Decisions)
- [x] commands `createTag` ("Create Tag Here…"), `createAnnotatedTag` ("Create Annotated Tag Here…") on graph rows (`webview/context`, group `1_create`) — input box validated like branch names against existing tags (`branchNameError` with a tag wording: add `tagNameError` next to it), annotated → second input box for the message (empty = cancel)
- [x] commands `deleteTag` (modal "Delete tag 'x'? It stays on remotes it was pushed to.") and `pushTag` (progress notification with Cancel, like Push) in the Tags tree item context; success texts "Created tag 'x' at abc1234." / "Pushed tag 'x' to origin."
- [x] integration tests on a temp repo (style of `test/repo.integration.test.ts`): lightweight + annotated tag on a sha, invalid name rejected, delete, push to a bare remote

**Done when:** `pnpm typecheck && pnpm test` green; `pnpm build` ok; right-click a graph row → both tag items; Tags tree → Delete/Push. Manifest test green.

**Session:** sonnet, high; sequential (first).

### 2. Remote links and upstream

- [x] pure `src/git/remoteUrl.ts` (no `vscode`): `webBase(remoteUrl): { base: string; host: 'github' | 'gitlab' | 'bitbucket' } | undefined` for `https://host/g/r(.git)`, `http://`, `git@host:g/r(.git)`, `ssh://git@host(:port)/g/r(.git)` (port dropped, credentials in https URLs dropped); `commitLink(b, sha)`, `branchLink(b, branch)` (each path segment `encodeURIComponent`, `/` kept). Literal-fixture unit tests incl. GitLab subgroups (`g/sub/r`) and `.git` suffix
- [x] `Repo.remoteUrl(remote)` (`git remote get-url --end-of-options <r>`, READ), `Repo.isOnRemote(sha)` (`git branch -r --contains <sha>` non-empty, READ)
- [x] `copyCommitLink` on graph rows (group `2_copy@3`): remote = upstream remote of the current branch → `origin` → first; if `!isOnRemote` → still copy, status-bar message "link copied — abc1234 isn't on any remote branch yet"; unknown host format → information message
- [x] `copyBranchLink` on Branches local items that have an upstream (link to the upstream branch on its remote) and on Remotes items (`origin/x` → remote `origin`, branch `x`); group `3_copy`
- [x] `setUpstream` on Branches local items (group `1_modify@3`): quick pick of remote branches (same-name ones first; "Unset Upstream" entry when one is set) → `Repo.setUpstream(branch, remoteBranch | null)` (`git branch --set-upstream-to=<r/b> --end-of-options <b>` / `git branch --unset-upstream --end-of-options <b>`); op `upstream`
- [x] integration tests: set/unset upstream against a bare remote, `remoteUrl`, `isOnRemote` before/after push

**Done when:** checks green; links verified by unit tests for all URL forms listed above.

**Session:** sonnet, high; after stage 1.

### 3. Reset, Cherry Pick, Revert

- [x] `contributes.submenus`: `gitsprout.resetSubmenu` ("Reset Current Branch to Here"), placed in `webview/context` for commit rows (group `3_modify@1`), containing `resetSoft` / `resetMixed` / `resetHard` ("Soft — keep changes staged", "Mixed — keep changes unstaged", "Hard — discard changes")
- [x] `Repo.reset(mode, sha)`: `git reset --<mode> <sha> --` (the sha is hex-validated by `shaFromArg`, the trailing `--` stops path parsing); detached HEAD → info "Reset needs a branch checked out."; hard → modal "Reset 'b' to abc1234? Uncommitted changes will be lost." (button "Reset")
- [x] `cherryPick` and `revert` on commit rows (group `3_modify@2/3`): `git cherry-pick [-m 1] <sha>` / `git revert --no-edit [-m 1] <sha>` (`-m 1` when the row's commit has >1 parents — take parent count from `git rev-list --parents -n 1 <sha>`); rules `LOCAL_CHANGES` + `CONFLICT`
- [x] cherry-pick guards: sha already reachable from HEAD (`git merge-base --is-ancestor <sha> HEAD`, okCodes [1]) → info "abc1234 is already in 'b'."; git stopping on an empty pick (`/previous cherry-pick is now empty/` in stderr) → `git cherry-pick --abort` and info "Nothing to cherry-pick: the changes are already in 'b'."
- [x] success texts: "Reset 'b' to abc1234 (mixed)." / "Cherry-picked abc1234 onto 'b'." / "Reverted abc1234 on 'b'."; Conflict → error with "Open Source Control" ("Resolve the conflicts and commit in Source Control, or run `git cherry-pick --abort`.")
- [x] integration tests: each reset mode (HEAD moves, index/worktree state), cherry-pick clean + conflict (state = cherry-pick in progress, error kind Conflict), already-contained guard, revert of a normal and a merge commit

**Done when:** checks green; integration tests cover all bullets.

**Session:** sonnet, max on the conflict/empty-pick bullets; after stage 2. Opus acceptance.

### 4. Compare with Working Tree, Save as Patch

- [x] `Repo.diffWithWorktree(sha)`: `git diff --name-status -z -M <sha> --` → `parseNameStatusZ` (tracked files only; untracked are not listed — note it in the README)
- [x] export `sideUri` from `src/diff/provider.ts` (or add `openChanges(root, title, plans)`); command `compareWithWorktree` on commit rows (group `4_compare`): `vscode.changes` with title "Changes since abc1234", resources `[fileUri, left = git(sha, origPath ?? path) | empty for 'A', right = file | empty for 'D']`; nothing differs → info "No differences between abc1234 and the working tree."
- [x] `savePatch` on commit rows (group `4_compare@2`, "Save as Patch…"): `git format-patch -1 --stdout <sha>`; empty output (merge) → info "Merge commits can't be saved as a patch."; `showSaveDialog` default `<root>/<short>-<subject-slug>.patch`, write with `vscode.workspace.fs.writeFile`
- [x] unit test for the resources builder (pure, in `src/diff/uri.ts`), integration test for `diffWithWorktree` (modified, added, deleted, renamed)

**Done when:** checks green; `pnpm package` builds the `.vsix`.

**Session:** sonnet, high; after stage 3.

### 5. Checkout this commit — optional, only on the user's go

Detached HEAD support: `checkoutCommit` on rows, tags in the Checkout quick pick check out detached (replace `TAG_CHECKOUT_MESSAGE`), status bar `$(git-commit) abc1234`, Branches view without a HEAD branch, Pull/Push/Reset/Set Upstream refuse with a clear message.

- [ ] audit every `head.branch` / `summary.branch` consumer and list the detached behaviour of each in this file before coding
- [ ] implement per the list; integration tests for checkout/back

**Done when:** checks green; the audit list is in this file with each item ticked.

**Session:** opus (judgement over many consumers); after stage 4, only if the user asks.

## Session prompts

Common to all stages: work in `/Users/fost/Projects/gitsprout`; rules `CLAUDE.md`; this file is the plan (stage section + "Context and constraints" + "Decisions"). Don't commit or push. Last message = report: done (files) / deviations / not verified / open questions.

### Stage 1
```
Session 1 — Gitsprout git actions: plumbing and tags · Model: sonnet, effort: high · first

Work in /Users/fost/Projects/gitsprout. Task: stage 1 of roadmap-git-actions.md (row context carries the repo root, Mutator export + src/commands/commits.ts, tag commands).

Read: roadmap-git-actions.md (Context, Decisions, stage 1); CLAUDE.md. Entry points: webview/render.ts:59 commitContext; src/commands/mutations.ts:26 registerMutations (target/mutate/fail), :171 createBranchFrom; src/commands/messages.ts:11 branchNameError, :140 Op, :158 errorPlan; src/git/repo.ts:176 createBranch (pattern for check-ref-format + --end-of-options), :222 publishRemote, :242 push; src/extension.ts:23-25 wiring; package.json menus webview/context and view/item/context (viewItem == tag); test/repo.integration.test.ts (temp repo helpers), test/manifest.test.ts.
Entry points were verified while planning — open only the fragment you edit.

Already decided: everything under "Decisions" in the roadmap.

Order: the stage 1 checkboxes top to bottom. Tick a box only after its check passes.

DoD: pnpm typecheck && pnpm test green, pnpm build ok. Long output to a log file, only the tail into context.
Don't: stages 2–5, refactors beyond the Mutator export, new runtime deps. A question the roadmap does not answer goes into the report and roadmap-git-actions.pending.md.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

### Stage 2
```
Session 2 — Gitsprout git actions: remote links and upstream · Model: sonnet, effort: high · after stage 1 is accepted

Work in /Users/fost/Projects/gitsprout. Task: stage 2 of roadmap-git-actions.md.

Read: roadmap-git-actions.md (Decisions, stage 2); CLAUDE.md. Entry points: src/commands/commits.ts (from stage 1: registerCommitCommands, Mutator from mutations.ts — add commands there, graph-row commands use target(rootFromArg(arg))); src/git/repo.ts:222 publishRemote (remote choice), READ opts; src/commands/messages.ts localBranchFromArg/remoteBranchFromArg; src/git/parse.ts + test/parse.test.ts (style for pure fixtures); package.json view/item/context for branch.local(.head) and branch.remote.

Order: stage 2 checkboxes top to bottom; tick after checks.
DoD: pnpm typecheck && pnpm test green, pnpm build ok.
Don't: other stages; network calls in unit tests. Unanswered questions → report + pending file.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

### Stage 3
```
Session 3 — Gitsprout git actions: reset, cherry-pick, revert · Model: sonnet, effort: high (max on conflict/empty-pick handling) · after stage 2 is accepted

Work in /Users/fost/Projects/gitsprout. Task: stage 3 of roadmap-git-actions.md.

Read: roadmap-git-actions.md (Decisions, stage 3); CLAUDE.md. Entry points: src/commands/commits.ts; src/git/repo.ts:13 CONFLICT and LOCAL_CHANGES rules, okCodes usage in checkoutRemote (:169); src/commands/messages.ts errorPlan; src/graph/validate.ts:72 shaFromArg; package.json (add contributes.submenus).

Order: stage 3 checkboxes top to bottom; tick after checks. Verify git's exact stderr for the empty cherry-pick on the installed git (write the integration test first).
DoD: pnpm typecheck && pnpm test green, pnpm build ok.
Don't: interactive rebase, abort/continue UI, other stages. Unanswered questions → report + pending file.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

### Stage 4
```
Session 4 — Gitsprout git actions: compare with working tree, save as patch · Model: sonnet, effort: high · after stage 3 is accepted

Work in /Users/fost/Projects/gitsprout. Task: stage 4 of roadmap-git-actions.md.

Read: roadmap-git-actions.md (stage 4); CLAUDE.md. Entry points: src/diff/uri.ts (Side, DiffPlan, commitFilePlan — pattern), src/diff/provider.ts:46 sideUri, :52 openPlan; src/git/repo.ts:77 commitFiles (name-status -z pattern), src/git/parse.ts:143 parseNameStatusZ; src/commands/commits.ts.

Order: stage 4 checkboxes; tick after checks. Then update README.md (Usage: the new graph/tree actions in one short list) and tick.
DoD: pnpm typecheck && pnpm test green, pnpm build ok, pnpm package builds the .vsix.
Don't: stage 5, untracked files in the compare. Unanswered questions → report + pending file.
Don't commit or push. Last message — report: done (files) / deviations / not verified / open questions.
```

Stage 5 prompt is written after stage 4's acceptance, if the user asks for it.

## Risks and open questions

- `vscode.changes` (multi-diff editor) accepting an undefined side is an assumption; stage 4 uses an empty `gitsprout:` side instead, so it does not depend on it. Cursor's VS Code base must have `vscode.changes` (assumption: VS Code ≥ 1.86) — fallback: quick pick of files → `openPlan` one by one.
- Empty cherry-pick wording differs between git versions — stage 3 checks it on the installed git first; the `--abort` fallback must not fire on a real conflict (integration test covers both).
- Commands from a graph row in a tab that isn't focused: the row context `root` (stage 1) makes them act on the right repo regardless of the active one.
- Hard reset loses uncommitted work irreversibly (commits stay in the reflog) — modal only, no undo.

## Order of work

Strictly sequential, one repo: 1 → 2 → 3 → 4, each accepted (`/plan-review`) and merged before the next. Stage 5 only on request.
