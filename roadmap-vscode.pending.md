# roadmap-vscode — pending

## Решения на подтверждение

- [архитектура] этап 1: TypeScript ^7.0.2 (нативный порт, npm latest) оставлен вместо ^5.x — tsc здесь только тайпчекер, esbuild/vitest транспилируют сами, JS API TypeScript никто не использует; `moduleResolution` убран из tsconfig (TS 7 не знает node10) — откат: `pnpm add -D typescript@~5.9` и `"moduleResolution": "bundler"` (или `"module": "preserve"`) в tsconfig.json
- [архитектура] этап 1: vitest ^4.1 вместо 5.0 — vitest 5 требует @types/node ^22, а @types/node@20 держим под Node 20 из VS Code 1.90; пара vitest 4.1 + @types/node 20 без peer-варнингов — откат: `pnpm add -D vitest@^5 @types/node@22` (и следить, чтобы в src/ не попали API Node 22)
- [архитектура] этап 1: `.vscode/` убран из .gitignore, launch.json/tasks.json коммитятся (F5 из коробки) — откат: вернуть `.vscode/` в .gitignore и `git rm --cached -r .vscode`

## Проверить руками

- Этап 1 · VS Code, папка /Users/fost/Projects/gitsprout · F5 («Run Extension») → должна подняться задача `pnpm: watch`, затем открыться Extension Development Host без ожидания/ошибки «task didn't finish».
- Этап 1 · Extension Development Host · в Activity Bar иконка-росток (монохромная, в цвет темы); в контейнере Gitsprout четыре пустых view: Branches, Remotes, Stashes, Tags (Repositories скрыт — контекст `gitsprout.multiRepo` = false).
- Этап 1 · Extension Development Host · ⌘⇧P → «Gitsprout: Show Graph» → уведомление «Gitsprout: not implemented yet.»; ⌥⌘G и ⌥⌘R дают то же уведомление.
- Этап 1 · `code --install-extension gitsprout-0.1.0.vsix` (и в Cursor) · расширение ставится, в списке расширений иконка — белый росток на зелёном (#2e7d32, цвет-заглушка — поменять, если не нравится).
