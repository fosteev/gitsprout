# roadmap-vscode — pending

## Решения на подтверждение

- [архитектура] этап 1: TypeScript ^7.0.2 (нативный порт, npm latest) оставлен вместо ^5.x — tsc здесь только тайпчекер, esbuild/vitest транспилируют сами, JS API TypeScript никто не использует; `moduleResolution` убран из tsconfig (TS 7 не знает node10) — откат: `pnpm add -D typescript@~5.9` и `"moduleResolution": "bundler"` (или `"module": "preserve"`) в tsconfig.json
- [архитектура] этап 1: vitest ^4.1 вместо 5.0 — vitest 5 требует @types/node ^22, а @types/node@20 держим под Node 20 из VS Code 1.90; пара vitest 4.1 + @types/node 20 без peer-варнингов — откат: `pnpm add -D vitest@^5 @types/node@22` (и следить, чтобы в src/ не попали API Node 22)
- [архитектура] этап 1: `.vscode/` убран из .gitignore, launch.json/tasks.json коммитятся (F5 из коробки) — откат: вернуть `.vscode/` в .gitignore и `git rm --cached -r .vscode`
- [архитектура] этап 2: классификация ошибок разнесена — `run.ts` знает только NotARepo/GitMissing/Auth, остальные виды (PushRejected, Conflict, LocalChanges, NotFullyMerged, NothingToStash) навешивает `Repo` regex'ом по stderr+stdout и только поверх Other; у `GitError` 5-й аргумент `stdout` — git пишет CONFLICT и «No local changes to save» в stdout, а правило зависит от метода — откат: перенести правила в `run(…, { rules })`, stdout оставить
- [архитектура] этап 2: `Repo.summary()` возвращает `SummaryStatus`, `RepoSummary extends SummaryStatus` (+root/name/relPath/group заполняет реестр этапа 3); `stashFiles()` → `StashFile[]` (`FileStat` + `untracked`) — repo не знает про воркспейс, а таблице диффов этапа 4 нужен флаг untracked — откат: слить типы обратно в `RepoSummary`/`FileStat[]` и считать untracked в провайдере
- [скоуп] этап 2: `createBranch` создаёт ветку с `--no-track` — ветка от `origin/main` больше не трекает `origin/main`; Push публикует её как `origin/<имя>` (иначе Push падал на push.default=simple, а «починка» refspec'ом залила бы фичу в main) — откат: убрать `--no-track` в `src/git/repo.ts` createBranch и решить, куда пушить ветку с чужим именем апстрима
- [скоуп] этап 2: Push без upstream выбирает remote по `branch.<b>.pushRemote` → `remote.pushDefault` → `branch.<b>.remote` → `origin` → первый, а не «первый remote» из контракта (алфавитно первый часто не origin); на detached HEAD — понятная ошибка — откат: `publishRemote()` в `src/git/repo.ts` вернуть к `remotes[0]`
- [скоуп] этап 2: «Host key verification failed» и `Permission denied (publickey,password)` классифицируются как Auth → пользователю предложат «Run in Terminal» (там можно ответить на вопрос ssh про ключ хоста) — откат: убрать фразу из `classify()` в `src/git/run.ts`

## Проверить руками

- Этап 1 · VS Code, папка /Users/fost/Projects/gitsprout · F5 («Run Extension») → должна подняться задача `pnpm: watch`, затем открыться Extension Development Host без ожидания/ошибки «task didn't finish».
- Этап 1 · Extension Development Host · в Activity Bar иконка-росток (монохромная, в цвет темы); в контейнере Gitsprout четыре пустых view: Branches, Remotes, Stashes, Tags (Repositories скрыт — контекст `gitsprout.multiRepo` = false).
- Этап 1 · Extension Development Host · ⌘⇧P → «Gitsprout: Show Graph» → уведомление «Gitsprout: not implemented yet.»; ⌥⌘G и ⌥⌘R дают то же уведомление.
- Этап 1 · `code --install-extension gitsprout-0.1.0.vsix` (и в Cursor) · расширение ставится, в списке расширений иконка — белый росток на зелёном (#2e7d32, цвет-заглушка — поменять, если не нравится).
- Этап 2 · терминал, любой свой репо с SSH-remote, к которому нет доступа (или `GIT_SSH_COMMAND='ssh -i /dev/null -o IdentitiesOnly=yes'`) · в этапе 6 Push/Fetch из Gitsprout → должна прийти ошибка вида Auth с кнопкой «Run in Terminal», а не «Other». Классификация Auth проверена только на фикстурах строк, не на живом remote.
