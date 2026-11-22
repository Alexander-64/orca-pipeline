# Agent Pipeline

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

Publisher: [Alexander-64 на GitHub](https://github.com/Alexander-64). Лицензия: [MIT](LICENSE).

Orca-плагин для агентных DAG-сценариев: planner составляет YAML, Orca исполняет шаги через Run/Task/Dispatch, Beads показывает задачи, а coordinator переключает подтверждённо упавший по quota шаг на следующего агента с continuation checkpoint.

Версия **0.1.2** использует manifest v2, `id: "agent-pipeline"` и `license: "MIT"`. Deprecated-поле `publisher` удалено: Orca получает владельца из GitHub, поэтому ключ установки — `alexander-64.agent-pipeline`. Локальная папка без publisher получает ключ `local.agent-pipeline`.

## Установка из тега

После публикации тега 0.1.2:

```sh
orca plugin install Alexander-64/orca-pipeline@v0.1.2 --json
```

Нужны Orca **1.4.248+** и доступный `orca` CLI. Orca закрепляет точный commit тега. Исполняемый плагин требует approval: просмотрите доступ и выполните возвращённую Orca команду с `--approve <fingerprint>`, если согласны. `trusted-worker` — отдельный Node-процесс с полным доступом от имени пользователя: файлы, сеть и внешние программы. Capabilities ограничивают вызовы Orca API, но не изолируют Node-процесс.

Разрешения: `agent:read` для списка агентов, `workspace:read` для workspaces, `terminal:send` для создания coordinator terminals, `storage:own` для сохранения планов/Runs/journal, `settings:own` для настроек. У плагина одна панель Agent Pipeline с четырьмя внутренними представлениями.

На coordinator host установите и настройте `bd`, инициализируйте Beads в целевом репозитории (`bd init`). Задайте команду или абсолютный путь в Settings → Plugins → Agent Pipeline → Beads CLI executable; при недоступном bd доска показывает ошибку. Внешние агентные CLI и их авторизацию настройте в Orca на каждом host выполнения. Для live quota нужен `codex app-server`, для PR workflow — авторизованный `gh` на coordinator host. Эти CLI и учётные записи не входят в плагин. Node.js 22+ и `npm ci` нужны для разработки, установка из тега их не требует.

## Сценарии в репозитории

На вкладке **Scenario** выберите workspace на машине координатора. Откройте **Repository scenarios → Browse pipelines/** и выберите YAML. **Save file** сохраняет черновик в `pipelines/`. Чтобы обновить существующий файл, сначала откройте его. Если файл изменили на диске, панель предложит открыть его заново.

В **Run preview** до запуска видны зависимости, основной и запасные агенты, host, worktree, подтверждения, независимая проверка и команды приёмки. Агент выбирается с учётом квоты при запуске шага.

В репозитории есть [сценарий релиза](pipelines/release.yaml) с подтверждением перед публикацией и [пример переключения агента](examples/failover/README.md) с имитацией исчерпания квоты.

## Возможности

- Четыре представления в одной панели: сценарий, выполнение, метрики и Beads.
- Planner-агент создаёт YAML; визуальный DAG-редактор доступен сразу и синхронизирован с шаблонами и YAML. Карта группирует шаги в топологические волны, показывает зависимости, агентов и gates. Выберите карточку для inspector: поля и зависимости применяются кнопкой **Apply step** после проверки. Можно добавить независимый или дочерний шаг, дублировать и удалить выбранный (кроме последнего); ссылки на удалённый шаг очищаются. YAML можно свернуть; при ошибке сохраняется последняя валидная карта, а изменения графа блокируются до исправления YAML. Проверка и запуск всегда используют текущий YAML draft.
- Durable mutation journal: request IDs, request-show и replay без дублей после неизвестного результата.
- Evidence Gate с независимым reviewer и ограниченным repair → re-review циклом.
- Handoff 2.0 и артефакты попыток с redaction, ограничением размера и безопасными именами.
- Глобальные/provider/host лимиты параллелизма, role policies и quota-aware выбор агента.
- Remote preflight без скрытого local fallback, allowlist и read-only command policies.
- Нативные approval gates, pause/resume/cancel/retry и ручная смена агента.
- Beads: поиск, фильтры, claim/close/reopen, epics и синхронизация статусов.
- Метрики по агентам и timeline по Runs.
- PR после DAG, ожидание CI и merge только после approval и проверки неизменного head.

## Требования

- Orca 1.4.248 или новее.
- `bd` на coordinator host. Путь настраивается в Settings → Plugins → Agent Pipeline → Beads CLI executable.
- Node.js 22+ для разработки и тестов.

## Сценарий

```yaml
name: add-export
objective: Добавить экспорт и проверить его тестами
steps:
  - id: implement
    title: Реализация
    spec: Внести изменение в текущем workspace
    agent: codex
    fallback: [claude, kimi]
    placement:
      host: local
      worktree: current
    acceptance:
      - pnpm test
  - id: review
    title: Независимая проверка
    needs: [implement]
    spec: Проверить diff и повторно запустить тесты
    agent: claude
    placement:
      host: local
      worktree: current
    acceptance:
      - pnpm test
```

Для remote шага `placement.host` — имя saved Orca environment. `worktree: current` там запрещён: используйте exact selector или `new-top-level`/`new-child` с `placement.repo`. При недоступности remote плагин не переносит выполнение на локальную машину.

## Разработка

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run test:release
npm run check
npm run validate
orca plugin dev watch . --check --shot .orca/shots --json
```

`yaml` завендорен в `vendor/yaml` вместе с лицензией: Orca загружает плагин без bundler и разрешает относительные импорты. `node_modules` не входит в плагин.

## Границы текущей версии

- Orca подтверждает завершение через Task/worker_done; acceptance-команды выполняет назначенный worker. Для независимой повторной проверки используется `reviewAgent`.
- Живой quota snapshot реализован для Codex через `app-server`. Для других провайдеров применяется обычная fallback-цепочка.
- Failover между аккаунтами одного provider не реализован: текущий Orca `worker-start` не принимает account per-launch, а `account select` менял бы глобальный профиль.
- PR workflow требует `gh`; реальный PR/merge в тестах не создаётся.
- Planner и pipeline создают отдельные coordinator terminals в выбранном workspace.
- Плагин имеет `trusted-worker` доступ и вызывает `orca`/`bd` через `execFile`, без shell.

### Planner и редактор

Карточка Planner показывает цель, агента, running/done/failed, Run ID и ошибку; после генерации — name, objective, число шагов и волн. Последний план восстанавливается после открытия панели, а уже применённый результат не заменяет последующие ручные правки. Название и цель сценария редактируются над картой с проверкой перед применением.

Режимы **Map**, **YAML** и **Side by side** сохраняются между открытиями. В режиме **Side by side** карта и YAML расположены в адаптивной сетке с отдельной прокруткой, inspector расположен ниже; при невалидном YAML остаётся последняя валидная карта. Planner, step/review agent и fallback используют обнаруженных Orca агентов; пользовательские ID сохраняются в вариантах, fallback выбирается флажками в порядке выбора.

## Сборка релиза и проверка

После чистого checkout выполните `npm ci` (устанавливает версии из lockfile), затем `orca plugin types . --json`: это создаёт локальные `.orca/types`, необходимые для TypeScript. Orca и его CLI должны быть доступны на этой машине. Для Beads нужен установленный и настроенный `bd`; если используется локальная devDependency, укажите абсолютный путь `node_modules/.bin/bd` в настройках плагина. Подключите нужные агентные CLI и их учётные записи в Orca. Для PR workflow дополнительно нужны `gh` и авторизация на coordinator host.

Полная последовательность проверки из корня проекта:

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run test:release
npm run check
npm run validate
npm run build:release -- --out .release-smoke
orca plugin validate .release-smoke --json
```

`typecheck` проверяет типы; `test` запускает Orca-тесты; `test:release` отдельно запускает Node-тесты упаковки; `check` проверяет рендер панели и сценарии UI; `validate` проверяет manifest исходного проекта. Последняя команда валидирует именно release-каталог. Эти проверки не устанавливают и не публикуют плагин. Для интерактивной разработки `orca plugin dev watch . --check --shot .orca/shots --json` может потребовать разрешения на выполнение trusted-worker.

`npm run build:release` по умолчанию заменяет `dist/agent-pipeline` свежей сборкой без устаревших или dev-файлов. Сборка готовится во временном соседнем каталоге; при ошибке замены предыдущая сборка восстанавливается. `--out <path>` выбирает другой каталог (относительно корня проекта), который должен быть новым: перезапись разрешена только для стандартного `dist/agent-pipeline`. Не запускайте стандартную сборку, пока этот каталог обслуживает установленный плагин или активный Run; используйте новый `--out`.

Сборщик на Node.js не вызывает shell и не требует новых зависимостей. Он копирует явный список production-модулей, manifest, три README, корневой LICENSE при наличии и `vendor/yaml` с upstream-лицензией. Проверяет относительные импорты и точки входа, проверяет PNG из manifest, отвергает symlinks, прочие бинарные данные и известные шаблоны секретов. Tests, fixtures, UI check-сценарии, package manager files, node_modules, `.orca`, `.agent-pipeline`, logs, карты исходников и dev artifacts в поставку не входят. Новые production-модули нужно явно внести в `scripts/build-release.mjs`. Проверка шаблонов не заменяет ручной просмотр содержимого перед публикацией. `npm run test:release` отдельно проверяет состав, побайтовое совпадение с исходниками и защиту от перезаписи/symlinks.

## GitHub и Orca Community

Официальный Community-путь — публичный GitHub-репозиторий с `orca-plugin.json` manifest v2 в корне. `publisher` не указывается: при `engines.orca >=1.4.248` Orca определяет владельца по GitHub-репозиторию. В корне обязателен LICENSE; проект использует MIT, YAML сохраняет собственный `vendor/yaml/LICENSE`. В публикуемом дереве разрешены заявленные PNG, запрещены исполняемые файлы, нативные модули, архивы и символьные ссылки. Исходные `.ts`/`.tsx` Orca загружает напрямую; отдельный бинарный bundle не нужен.

Подтверждённый репозиторий: `https://github.com/Alexander-64/orca-pipeline`. Просмотрите diff и файлы, выполните проверки выше. Manifest должен оставаться в корне repo, а не только внутри dist. Сохраните совпадающую версию в manifest/package metadata, добавьте topic `orca-plugin`, создайте и отправьте tag `v0.1.2` для этой версии. Статус индексации: `https://orca.dev/plugins/alexander-64/orca-pipeline`. PR в `stablyai/orca-plugins` для Community **не нужен**. Локальная валидация сама по себе не означает, что Community уже проиндексировал релиз.

После публикации установка пользователем: `orca plugin install Alexander-64/orca-pipeline@v0.1.2 --json`. Для исполняемого плагина Orca возвращает запрос approval с перечнем доступа; подтверждение выполняет пользователь. `private: true` в package.json предотвращает случайный npm publish и не мешает GitHub/Community. Эта инструкция не выполняет создание repo, commit, push, tag или публикацию.

Правила: [руководство Orca](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md), [manifest](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-manifest.md), [листинг](https://orca.dev/plugins/add) и [политика каталога](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-listing-policy.md).
