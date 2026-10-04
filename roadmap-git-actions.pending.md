# roadmap-git-actions — pending

## Решения на подтверждение

- [скоуп] общее: Cherry Pick и Revert создают коммиты (правило «extension never stages or commits» уточнено в CLAUDE.md: нет UI стейджинга/коммита, git-операции могут коммитить) — откат: убрать этап 3 кроме Reset — принято по «делаем roadmap» 2026-10-04, явного ответа не было
- [скоуп] этап 1: Push Tag не использует правило PushRejected (его текст «Pull first» для тега бессмыслен) — отклонённый push тега показывается как «Push failed: …» с «Show Command Output»; Auth по-прежнему даёт «Run in Terminal» — откат: `PUSH_REJECTED` в `Repo.pushTag` (src/git/repo.ts)
- [скоуп] этап 1: Delete/Push Tag из дерева Tags действуют на активный репо (узлы дерева без root; дерево и так показывает активный) — откат: не нужен
- [скоуп] этап 2: Copy Link to Branch показан на всех локальных ветках дерева Branches (contextValue не различает наличие upstream); у ветки без upstream — информационное сообщение «has no upstream branch» — откат: не нужен (альтернатива: отдельный contextValue `branch.local.up`, ломает существующие `when`)
- [скоуп] этап 2: ошибки Copy Link показываются обычным error-сообщением, без `Op` — откат: не нужен

## Проверить руками

- Этап 1 · вкладка графа, правый клик по строке · «Create Branch Here…», «Create Tag Here…», «Create Annotated Tag Here…» рядом; тег с пробелом в имени — ошибка валидации в input box; существующее имя — «A tag named … already exists»; annotated — второй input box, Escape на нём ничего не создаёт. Тег появляется в Tags и пилюлей в графе.
- Этап 1 · две вкладки графа (репо A и B), A в фокусе · правый клик по строке во вкладке B → Create Tag Here… → тег создан в B, не в A.
- Этап 1 · Tags · правый клик → Push Tag → уведомление с Cancel, «Pushed tag 'x' to origin.»; Delete Tag → модалка, тег исчез.
- Этап 2 · граф, правый клик по строке · «Copy Link to Commit» → вставить в браузер, ссылка открывает коммит (GitHub/GitLab); коммит, которого нет на remote, — ссылка копируется, в статус-баре «isn't on any remote branch yet».
- Этап 2 · Branches · правый клик по локальной ветке · «Set Upstream…» → quick pick (одноимённые сверху, «Unset Upstream» при наличии upstream); «Copy Link to Branch» у ветки с upstream и у ветки без (сообщение). Remotes · «Copy Link to Branch» на origin/x.
- Этап 3 · граф, правый клик по строке · «Reset Current Branch to Here ▸» (Soft/Mixed/Hard), «Cherry Pick Commit», «Revert Commit» в группе после копирования; Hard — модалка «Reset 'b' to abc1234? …», Soft/Mixed без; на detached HEAD Reset — «needs a branch checked out»; cherry-pick с конфликтом — ошибка с «Open Source Control», в SCM видны конфликты; во вкладке репо B (при активном A) действие идёт в B.
- Этап 3 · там же · пункты подменю Reset получают контекст строки (sha + root): после Mixed ветка стоит на выбранном коммите, а не «right-click a commit in the graph». Повторный Revert уже откаченного коммита → «Nothing to revert: …», в SCM нет висящего revert.
