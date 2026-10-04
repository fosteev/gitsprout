# Roadmap — inline diff in the graph panel

## Goal

Clicking a file in the details pane (commit files, WIP staged/unstaged lists) shows its diff **inside the graph
webview, in place of the commit graph**. The details pane stays on the right, so another click switches the
diff to that file, like GitKraken. A close button or Esc brings the graph back. The native VS Code diff editor
stays one button away ("Open in Editor").

This overrides the CLAUDE.md line "the real extension uses native VS Code UI wherever the prototype emulates it
(… diff editor …)" for this one view, at the user's request (2026-10-04). Tree views (stashes, compare with working
tree, etc.) keep opening the native diff editor.

## Decisions (taken; don't revisit without the user)

1. **Own renderer.** The native diff editor can't be embedded in a webview, so the extension runs `git diff`,
   a pure parser turns the patch into hunks, and the webview renders them. There's no syntax highlighting and
   no runtime dependencies. Styling follows the prototype's diff emulation (`prototype/vscode.html:215-235`:
   `.diff`, `.inl`, `.sbs`, `.n`, `.c`, `.fold`, `.binary`).
2. **Two modes: Inline (default) and Split.** A toggle chip in the diff bar switches between them. The mode is
   persisted in `api.setState` next to `paneWidth`, not tied to a repo.
3. **Git commands** (all through `Repo.git`, `READ` options, `--no-color --no-ext-diff -M`, default `-U3`):
   - commit with a first parent: `git diff --no-color --no-ext-diff -M <parent> <sha> -- [<origPath>] <path>`
   - root commit: `git diff-tree -p -r -M --root --no-commit-id --no-color --no-ext-diff <sha> -- <path>`
   - staged: `git diff --cached --no-color --no-ext-diff -M -- [<origPath>] <path>` (verify it works on an unborn branch)
   - unstaged tracked: `git diff --no-color --no-ext-diff -- <path>`
   - untracked: `git diff --no-index --no-color --no-ext-diff -- /dev/null <path>`, `okCodes: [1]`
   - Output larger than run.ts's `MAX_BUFFER` → the `GitError` text becomes the diff's `error`. The webview shows
     it with "Open in Editor".
4. **Parser** `parsePatch(text: string, maxLines = 10000): FilePatch` in `src/git/parse.ts`; types in `src/git/types.ts`:
   ```ts
   export interface PatchLine { kind: ' ' | '+' | '-'; text: string; old: number | null; new: number | null }
   export interface Hunk { header: string; oldStart: number; newStart: number; lines: PatchLine[] }
   export interface FilePatch { binary: boolean; hunks: Hunk[]; truncated: boolean }
   ```
   - Lines before the first `@@` are file headers and are skipped. `Binary files … differ` or `GIT binary patch`
     sets `binary: true`.
   - `@@ -a[,b] +c[,d] @@ section` starts a hunk. `header` is the whole `@@` line. Omitted counts mean 1.
   - In a hunk, the first char is `' '`, `+` or `-`. Empty lines are context `''`, `\ No newline at end of file`
     is skipped, and a trailing `\r` is stripped from `text`.
   - Line numbers: context gets both numbers, `-` gets `old` only, `+` gets `new` only.
   - After `maxLines` hunk lines, stop and set `truncated: true`.
5. **Protocol** (`src/graph/protocol.ts`, plus validation in `src/graph/validate.ts`):
   - FromWebview `{ type: 'diffCommitFile'; req: number; sha: string; file: FileStat }` and
     `{ type: 'diffWipFile'; req: number; file: FileChange; area: 'staged' | 'unstaged' }`. `req` is a positive
     safe integer.
   - ToWebview `{ type: 'diff'; req: number; patch: FilePatch } | { type: 'diff'; req: number; error: string }`.
   - The existing `openCommitFile` / `openWipFile` stay as they are. They now mean "native editor" and are sent
     by the "Open in Editor" button.
   - The extension validates exactly like `openCommitFile` / `openWipFile` (`src/graph/panel.ts:192-205`): the
     commit must be known, and the WIP entry must be found in `this.wip`. Unknown requests are dropped silently.
     For a commit, the parent is `c.parents[0]` (merges diff against the first parent). Results are posted only
     if `root === this.root` after the await.
6. **Webview behaviour** (`webview/main.ts`, `webview/render.ts`, `webview/styles.css`):
   - A new `<div class="dview" id="dview" hidden>` occupies the graph's grid cell in `.split`. Open = `#list`
     hidden + `#dview` shown. Before hiding, save `list.scrollTop`. On close, restore it and `renderRows(true)`.
   - **Bar** (`.dbar`): the status letter (same `.st` classes), the path (dir muted, base name strong), and the
     context label: `<parent7> ↔ <sha7>` / `empty ↔ <sha7>` for commits, `Staged` / `Working Tree` /
     `Untracked` for WIP. On the right: `‹` `›` (Previous file (k) / Next file (j)), an `Inline`/`Split` chip
     (`aria-pressed`), `Open in Editor`, and `✕` (Close (Esc)).
   - **Body** (`.dbody`, scrolls). States:
     - `Loading…`
     - error text
     - binary → "Binary file — not shown."
     - no hunks → "No content changes."
     - hunks
     - truncated → a note under the last hunk: "Diff truncated at 10 000 lines — Open in Editor for the full diff."
   - **Inline**: grid with columns old#, new#, sign, text. Each hunk starts with a `.fold` row showing its `@@`
     header.
   - **Split**: grid with columns old#, old text, new#, new text. Context lines go on both sides. A run of `-`
     followed by a run of `+` is zipped row by row, and the shorter side is padded with hatched `.fill` cells.
   - Colors: `var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,.2))` and
     `var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,.2))`. Font `var(--mono)`, size
     `var(--vscode-editor-font-size, 12px)`. Text is `white-space: pre-wrap; word-break: break-all`. All file
     content goes through `esc()`.
   - **Requests**: a module counter `diffReq` is incremented per request. A `diff` answer with another `req` is
     ignored.
   - **Click** on a `.tr[data-file]` row in the details pane opens or switches the inline diff (no more native
     diff on click). The open file's row gets the class `on` (add a `.tr.on` style), re-applied after every
     details re-render.
   - **Prev/next** (buttons, `j`/`k` while the diff is open and focus is not in an input/textarea) walk
     `details.querySelectorAll('.tr[data-file]')` in DOM order across areas, without wrapping. ↑/↓ are not
     intercepted while the diff is open (native scroll).
   - **Close**: `✕`, or Esc while the diff is open and focus is not in an input/textarea. Clears the row
     highlight and focuses `#list`.
   - **Auto-close / follow**:
     - `reveal` from the tree views closes the diff, then selects.
     - A `state` for another repo root, or an `error`, closes it.
     - Typing in the search box or Enter/Shift+Enter there closes it first.
     - A commit diff closes when `selected` changes to another commit.
     - On a `state`, a WIP diff looks for the same `path`+`origPath` in its area. If found, it re-requests
       silently (keeps `.dbody` scrollTop). If found only in the other area, it switches to that area. If gone,
       it closes.
   - The open diff is **not** persisted across reloads; only the mode is.

## Stages

### 1. Git layer + parser — sonnet, high
- [x] `FilePatch` / `Hunk` / `PatchLine` types in `src/git/types.ts`
- [x] `parsePatch` in `src/git/parse.ts` + literal-fixture tests in `test/parse.test.ts`: multi-hunk modify, added file, deleted file, rename-only (no hunks), binary, `\ No newline`, CRLF, `@@ -1 +1 @@`, section text in header, truncation
- [x] `Repo.patch(spec)` in `src/git/repo.ts` with `spec` = `{ kind: 'commit'; sha; parent: string | null; path; origPath } | { kind: 'staged'; path; origPath } | { kind: 'unstaged'; path } | { kind: 'untracked'; path }`
- [x] integration tests in `test/repo.integration.test.ts`: commit with parent, root commit, rename in a commit, staged (also on an unborn branch), unstaged, untracked

### 2. Protocol + extension — sonnet, high
- [x] `diffCommitFile` / `diffWipFile` / `diff` in `src/graph/protocol.ts`; validation + tests in `src/graph/validate.ts` / `test/graph.validate.test.ts`
- [x] handlers in `src/graph/panel.ts` next to `openCommitFile` / `openWipFile`

### 3. Webview — sonnet, high
- [x] diff view, bar, inline + split render (pure HTML builders in `webview/render.ts`, with tests in `test/graph.render.test.ts` for inline/split rows incl. zipped runs and `esc`)
- [x] click / prev-next / close / auto-close / follow rules from decision 6
- [x] happy-dom smoke test `test/diff.webview.test.ts` (pattern: `test/wip.webview.test.ts`): click file → `diffCommitFile` posted; answer → `#dview` shown, `#list` hidden; stale `req` ignored; Esc closes; `j` posts the next file; split toggle re-renders; WIP state without the file closes; `reveal` closes

### 4. Docs
- [x] `README.md` scope line about the inline diff; `CHANGELOG.md` entry; CLAUDE.md "native UI" line gets the exception for the inline diff

DoD: `pnpm typecheck && pnpm test && pnpm build` green. The user checks the look and feel with F5.

## Review of session 1 (2026-10-04)

Accepted. Checks are green. Fixes made during review:
- `src/graph/validate.ts`: the `parseFromWebview` doc comment had drifted onto `isReq`; it is back on the function.
- `webview/main.ts` `followDiff`: when a WIP file moves to the other area, the body now shows `Loading…` instead of the
  old area's patch.

Decisions the executor took, all accepted:
- There is one mode chip. Its label shows the current mode, and the title says which mode a click switches to.
- Any selection change closes the diff. In practice that means reveal, search, and the CI toggle.
- Esc doesn't close the diff while focus is in the Commit ▾ menu: there it closes the menu first.
- `tsconfig.json` / `webview/tsconfig.json` list the new DOM test, following the pattern of `wip.webview.test.ts`.

Waiting on the user: an F5 check of how it looks (split hatching, colors in light and dark themes) and of a huge diff (the
`MAX_BUFFER` error path).

## Session prompts

### Session 1 — all stages · Модель: sonnet, effort: high

Работаем в /Users/fost/Projects/gitsprout. Задача: показывать diff файла внутри webview графа вместо дерева
коммитов (как в GitKraken), с закрытием и переключением между файлами. Это новая фича поверх готового графа
и WIP-панели.

Читай: /Users/fost/Projects/gitsprout/roadmap-inline-diff.md (весь — решения там окончательные);
правила репо — /Users/fost/Projects/gitsprout/CLAUDE.md. Стиль диффа —
prototype/vscode.html:215-235 (только CSS-блок, остальное не читать).

Точки входа:
- src/git/repo.ts:31 `git()`, :130 `show()` — эталон чтения
- src/git/parse.ts — сюда `parsePatch`
- src/git/run.ts:9 `okCodes`
- src/graph/protocol.ts — типы сообщений
- src/graph/validate.ts:74-81 — эталон валидации `openCommitFile` / `openWipFile`
- src/graph/panel.ts:192-205 — эталон обработчиков
- webview/main.ts:96-114 — разметка `.split`; :70-94 restore/persist; :410-428 клик по файлам;
  :604 клавиатура; :586-589 поиск; :341 обработчик сообщений
- webview/render.ts:106 и :220 — строки файлов `.tr[data-file]`
- webview/styles.css:55 `.split`, :109 `.tr`
- test/wip.webview.test.ts — эталон happy-dom смоук-теста

Точки входа и эталоны проверены при планировании: не перечитывай их ради подтверждения, открывай только
фрагмент, который правишь.

Уже решено, не переспрашивать: всё в разделе «Decisions» roadmap — команды git, формат `FilePatch`, протокол,
поведение webview, тексты UI.

Порядок: этапы 1 → 2 → 3 → 4 из roadmap. После каждого этапа — `pnpm typecheck && pnpm test`. Галочки в
roadmap — по факту проверки.

DoD: `pnpm typecheck && pnpm test && pnpm build` зелёные, все галочки этапов 1–4 стоят. Длинный вывод — в файл,
в контекст только `tail -30`.

Не делать:
- подсветку синтаксиса и новые зависимости;
- стейджинг ханков и кнопки stage/discard в баре диффа;
- изменения в tree views и `src/diff/provider.ts`;
- «заодно улучшить».
Чужие незакоммиченные файлы не трогать. Вопрос, на который нет ответа в roadmap, — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от
плана / не проверено / открытые вопросы. Отчёт — единственное, что увидит приёмка: без него работа потеряна.
