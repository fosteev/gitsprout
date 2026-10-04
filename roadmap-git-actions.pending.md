# roadmap-git-actions — pending

## Решения на подтверждение

- [скоуп] общее: Cherry Pick и Revert создают коммиты (правило «extension never stages or commits» уточнено в CLAUDE.md: нет UI стейджинга/коммита, git-операции могут коммитить) — откат: убрать этап 3 кроме Reset — принято по «делаем roadmap» 2026-10-04, явного ответа не было
- [скоуп] этап 1: Push Tag не использует правило PushRejected (его текст «Pull first» для тега бессмыслен) — отклонённый push тега показывается как «Push failed: …» с «Show Command Output»; Auth по-прежнему даёт «Run in Terminal» — откат: `PUSH_REJECTED` в `Repo.pushTag` (src/git/repo.ts)
- [скоуп] этап 1: Delete/Push Tag из дерева Tags действуют на активный репо (узлы дерева без root; дерево и так показывает активный) — откат: не нужен

## Проверить руками

- Этап 1 · вкладка графа, правый клик по строке · «Create Branch Here…», «Create Tag Here…», «Create Annotated Tag Here…» рядом; тег с пробелом в имени — ошибка валидации в input box; существующее имя — «A tag named … already exists»; annotated — второй input box, Escape на нём ничего не создаёт. Тег появляется в Tags и пилюлей в графе.
- Этап 1 · две вкладки графа (репо A и B), A в фокусе · правый клик по строке во вкладке B → Create Tag Here… → тег создан в B, не в A.
- Этап 1 · Tags · правый клик → Push Tag → уведомление с Cancel, «Pushed tag 'x' to origin.»; Delete Tag → модалка, тег исчез.
