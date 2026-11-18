# Publii Plus — форк Publii

Publii Plus — форк [GetPublii/Publii](https://github.com/GetPublii/Publii) (GPL-3.0) с дополнительными
возможностями (ИИ, редактор тем, инструменты разработчика). Основа сейчас: **Publii 0.48.3**.
Версия Publii Plus: `app/back-end/plus/version.json`.

## Принципы

1. **Свой код — в своих папках.** Всё новое лежит в `app/back-end/plus/` (основной процесс) и
   `app/src/plus/` (интерфейс). Файлы Publii меняются только в местах, перечисленных ниже.
2. **Каждая правка ядра помечена** комментарием `PUBLII-PLUS` и внесена в таблицу ниже.
   Проверка: `git grep -n "PUBLII-PLUS"`.
3. **Новые функции — через расширения**, а не правкой файлов Publii. Нужна новая точка в интерфейсе —
   добавляется один `<plus-slot name="...">` в шаблон Publii (и строка в таблицу).

## Правки ядра Publii

| Файл | Что изменено | Зачем |
|---|---|---|
| `package.json` | `productName`, `name`, `appId`, `executableName`, `artifactName`, заголовок dmg, ссылки на репозиторий; в `test` добавлен `app/src/plus/**/*.spec.js` | отдельное приложение «Publii Plus», наши тесты |
| `app/package.json`, `package-lock.json`, `app/package-lock.json` | `productName`/`name` | имя приложения, папка служебных данных Electron |
| `app/main.js` | после `applicationMenu.install()` вызывается `require('./back-end/plus').init(...)` | загрузка расширений, предупреждение о запущенном Publii |
| `app/back-end/app-preload.js` | `mainProcessAPI.invoke` пропускает каналы `plus:<расширение>:<метод>` | вызовы основного процесса из расширений |
| `app/src/main.js` | `import PubliiPlus` + `Vue.use(PubliiPlus)` | реестр расширений в интерфейсе, компонент `<plus-slot>` |
| `app/src/components/About.vue` | `<plus-slot name="about" />` | версия Publii Plus и список расширений |
| `app/src/components/post-editor/Sidebar.vue` | `<plus-slot name="post-editor-sidebar" :context="$parent" />` перед «Other options» | панель AI Assistant в редакторе |
| `app/src/components/AppSettings.vue` | `<plus-slot name="app-settings" />` после последней группы | настройки AI-провайдеров |
| `app/src/components/Sidebar.vue` | `<plus-slot name="site-sidebar" />` перед кнопкой Preview | кнопка «AI agent» |
| `app/src/components/ThemeSettings.vue` | `<plus-slot name="theme-settings" />` под заголовком | кнопка «Edit theme files» |
| `app/src/components/AppPlugins.vue`, `AppThemes.vue` | `<plus-slot name="app-plugins" / "app-themes">` под заголовком | менеджер расширений, мастерская плагинов |
| `app/back-end/modules/render-html/renderer-plugins.js` | одна строка перед `module.exports`: если задана переменная `PUBLII_PLUS_HOOK_LOG`, подключается `plus/hook-logger.js` | журнал хуков мастерской плагинов (без переменной поведение не меняется) |
| `README.md` | заметка о форке в начале файла | ссылка на этот документ |
| `.github/workflows/plus-*.yml` | новые файлы | CI, сборка Windows, синхронизация с upstream |

## Данные и совместная работа с официальным Publii

- Сайты, темы, плагины и настройки — **общие** с официальным Publii: `Documents/Publii`.
- Служебные данные Electron (окна, кэш) — свои: `…/Publii Plus` в папке приложений системы.
- Пароли деплоя (связка ключей) — общие; на macOS при первом обращении система спросит разрешение.
- Защита Publii от двойного запуска привязана к имени приложения, поэтому **не открывайте один и тот же сайт
  в Publii и Publii Plus одновременно**. При запуске Publii Plus предупреждает, если работает официальный Publii.
- «Check for Updates» открывает центр уведомлений Publii: он может сообщить о новой версии **официального**
  Publii. Обновлять Publii Plus нужно из этого репозитория.

## Ветки и обновление Publii

- `master` — Publii Plus, рабочая ветка.
- `upstream` — точная копия `GetPublii/Publii` (master). Её обновляет workflow **Sync upstream Publii**
  (по понедельникам и вручную): он пробно сливает upstream в master, запускает тесты и открывает/обновляет
  PR `upstream → master` с результатом. Перед слиянием — пройтись по таблице правок ядра.
- Конфликт вручную: `git fetch origin && git merge origin/upstream`, решить конфликты, `npm test`.

Нужно один раз включить в настройках репозитория на GitHub:
Settings → Actions → General → «Allow all actions» и **«Allow GitHub Actions to create and approve pull requests»**.

## Сборка

Нужен Node.js из `.nvmrc` (22.x).

```bash
npm ci
npm ci --prefix app
npm run prepare-editor
npm run prod
```

- Запуск из исходников: `npm run build2` (или `npm run build` — увеличивает номер сборки).
- **macOS** (локально, на том же Mac): `npm run packager:mac-m` (Apple Silicon) или `npm run packager:mac-intel`.
  Локальная сборка запускается без нотаризации.
- **Windows**: workflow **Build Windows** собирает неподписанный установщик при каждом push в master;
  скачать — Actions → Build Windows → последний запуск → Artifacts. При первом запуске SmartScreen
  покажет предупреждение («Подробнее» → «Выполнить в любом случае»).
- Если Electron ругается на версию нативного модуля: `npx electron-builder install-app-deps`.

## Расширения

Расширение = две части с одинаковым id:

- `app/back-end/plus/extensions/<id>/index.js` — основной процесс:
  ```js
  module.exports = {
      id: 'my-extension', name: 'My extension',
      register (ctx) {
          // ctx: { id, appInstance, electronApp, paths: { appDir, extensionDir }, handle, log }
          ctx.handle('hello', async (event, name) => `Hello ${name}`);   // канал plus:my-extension:hello
      }
  };
  ```
- `app/src/plus/extensions/<id>/index.js` — интерфейс:
  ```js
  import Panel from './Panel.vue';
  export default { id: 'my-extension', slots: { 'about': Panel } };
  // в компоненте: await this.$plus.invoke('my-extension', 'hello', 'Publii')
  ```

Обе части подключаются автоматически. Пример — расширение `core` (строка Publii Plus на экране About).
Ошибка в одном расширении не мешает остальным; список загруженных и упавших расширений виден на экране About.

Доступные слоты:

| Слот | Где | `context` |
|---|---|---|
| `about` | экран About | — |
| `post-editor-sidebar` | боковая панель редактора записи/страницы (все три редактора) | компонент редактора: `postData`, `$refs`, `itemType` |
| `app-settings` | Settings приложения, после всех групп | — |
| `theme-settings` | страница Theme сайта, под заголовком | — |
| `app-plugins`, `app-themes` | страницы Plugins и Themes приложения | `'plugin'` / `'theme'` |
| `site-sidebar` | боковое меню сайта, над кнопкой Preview | — |

## AI Assistant (расширение `ai-assistant`)

- **Провайдеры** — Settings → «AI providers (Publii Plus)». Два протокола: OpenAI Responses API и
  OpenAI-совместимый Chat Completions (OpenRouter, Ollama, LM Studio, vLLM, свой сервер) по http или https.
  Шаблоны: OpenAI, OpenRouter, Ollama, LM Studio, Custom. Можно задать заголовок авторизации, свои заголовки,
  температуру, лимит токенов, таймаут; «Load models» берёт список из `/models`, «Test connection» делает пробный запрос.
- **Ключи** — в системной связке ключей (`publii-plus-ai`); если она недоступна — зашифрованы средствами Electron
  в `config/publii-plus-ai.secrets.json`; если недоступно и это — ключ не сохраняется. Ключи не передаются в интерфейс.
  Настройки без ключей: `Documents/Publii/config/publii-plus-ai.json`.
- **Структурированный ответ** — JSON Schema; если сервер её не поддерживает, автоматически JSON через промпт;
  при невалидном ответе — одна попытка исправления.
- **В редакторе** (секция «AI Assistant» в боковой панели): SEO (meta title ≤ 70, description ≤ 160, slug),
  теги (сначала существующие), черновик по описанию (Markdown → HTML для визуального редактора),
  переписывание выделенного фрагмента. Всё применяется только по кнопке; запросы можно отменить.
- **Пост целиком**: во вкладке Write галочка «Also create title, SEO fields and tags» (по умолчанию включена) —
  один запрос возвращает заголовок, текст, SEO и теги; кнопка «Apply everything» заменяет содержимое и заполняет все поля.
  Язык текста — язык описания (язык сайта — только если язык описания неясен).
- **Инструкции для ИИ** (Settings → AI providers → Instructions for AI): для всех сайтов и отдельно для текущего сайта
  (например, какие HTML-элементы и классы типографики поддерживает тема). Добавляются в каждый запрос после
  встроенных правил.
- **Стили темы**: стили, которые тема объявляет для редактора (`config.json` → `customElements`: Info, Warning, Drop cap,
  классы таблиц и т.п.), автоматически передаются модели при написании и переписывании текста; модель вставляет их как
  HTML там, где они подходят по смыслу. Выключается в Settings → Instructions for AI → Theme styles; там же виден список
  найденных стилей текущего сайта. Другого HTML в черновиках модель не использует, если его не разрешают инструкции.
- **Ограничения**: блочный редактор — только SEO, теги и копирование черновика (вставка и переписывание недоступны).
- **Приватность**: заголовок и текст записи отправляются выбранному провайдеру. Для полностью локальной работы — Ollama/LM Studio.

## AI-агент (часть расширения `ai-assistant`)

- **Где**: кнопка «✦ AI agent» в боковом меню сайта → панель чата справа. Чат остаётся при переходах между
  разделами сайта (Posts, Tags, Theme…); «New chat» начинает заново. Работает с провайдерами и инструкциями
  из Settings → AI providers (тот же список, выбор провайдера в панели).
- **Что умеет агент** (инструменты):
  - читать: сведения о сайте, список записей (поиск по заголовку, статусу, тегу), запись целиком, теги,
    файлы темы и их содержимое;
  - изменять: создать черновик (Markdown), изменить запись — заголовок, текст, теги, SEO title / meta description,
    статус draft/published; изменить или создать файл темы (сохраняется в `<тема>-override`, как в редакторе темы);
  - открыть предпросмотр сайта (Preview).
- **Подтверждение**: каждое изменение сначала показывается карточкой — что именно меняется и diff текста;
  «Apply» / «Reject» (можно написать, что сделать иначе — агент учтёт). Несколько изменений — «Apply all».
  Галочка «Apply changes without asking» применяет без вопросов (по умолчанию выключена).
- **Отмена**: у применённого изменения кнопка «Undo» (созданный черновик удаляется, поля записи и файл темы
  возвращаются к прежним значениям). Агент узнаёт об отмене со следующим сообщением.
- **Безопасность данных**: меняются только указанные поля (картинки, настройки вида и прочее не трогаются); URL (slug)
  при смене заголовка не меняется; файлы темы проверяются перед сохранением (ошибка Handlebars/JSON — не сохраняется).
  Агент не публикует сайт (Sync делаете вы) и не удаляет записи.
- **Ограничения**: только записи (не страницы); текст записей блочного редактора агент не меняет (заголовок, теги и
  SEO — можно); для визуального редактора Markdown агента превращается в HTML. Не более 16 шагов модели на одно
  сообщение («continue» — продолжить). Модель должна поддерживать вызов функций (tools): OpenAI, OpenRouter
  (большинство моделей), Ollama/LM Studio — модели с поддержкой tools.
- **Приватность**: содержимое записей и файлов темы, которое агент читает, отправляется выбранному провайдеру.
  Текст записей может содержать чужие инструкции («prompt injection») — поэтому подтверждение изменений лучше не отключать.

## Редактор файлов темы (расширение `theme-editor`)

- **Где**: Theme → «Edit theme files». Полноэкранный редактор: дерево текстовых файлов темы
  (шаблоны и partials — первыми, лицензии шрифтов скрыты), фильтр, «Changed only», подсветка кода (CodeMirror).
- **Как хранится**: правка никогда не меняет саму тему. Сохранение пишет файл в
  `<сайт>/input/themes/<тема>-override/<тот же путь>` — Publii берёт его вместо оригинала при рендере
  (шаблоны, partials, ассеты, `config.json`, JS темы), и обновление темы его не затирает.
  Сохранение содержимого, равного оригиналу, удаляет копию. «Revert to original» удаляет копию.
- **Новые файлы** (например, partial или CSS) создаются сразу в override.
- **Проверка** на лету и перед сохранением: Handlebars и JSON (ошибка блокирует сохранение), JS (ES-модули —
  только предупреждение), CSS (несбалансированные скобки — предупреждение). Клик по ошибке — переход к строке.
- **Compare with original** — diff текущего (в т.ч. несохранённого) текста с оригиналом.
- **Export changes (.diff)** — один unified diff всех изменённых и новых файлов темы, применимый `patch -p1`/`git apply`
  к папке темы: удобно передать изменения автору темы.
- **Preview site** — рендер предпросмотра Publii с изменениями.

Общая утилита diff: `app/back-end/plus/lib/unified-diff.js` (используется и в интерфейсе).

## Менеджер расширений (расширение `extensions-manager`)

- **Где**: Plugins и Themes приложения → блок «Catalog & updates»: «Open catalog» / «Show updates» и «Install from link».
- **Каталог**: плагины и темы из источников, у каждого — статус (Install / Update from vX / Installed), «Update all».
  Перед установкой: размер и SHA-256 из каталога, распаковка безопасным распаковщиком Publii, проверка
  (`plugin.json`/`config.json`, `main.js`, файлы `assets.front`, `minimumPubliiVersion`), запрет на замену плагина,
  у которого открыты настройки. Установка атомарна (staging-папка), списки Publii обновляются без перезапуска.
- **Установка по ссылке**: ссылка на `.zip` или на GitHub-репозиторий (`https://github.com/owner/repo[/tree/branch]`,
  скачивается архив без REST API — без лимита запросов). Сначала проверка и показ имени/версии, затем выбор имени
  папки (предлагается автоматически, например `publii-mermaid-support-plugin` → `mermaidSupport`; для обновлений
  оставляйте то же имя).
- **Источники** (вкладка Sources): GitHub-релиз (`owner/repo`, тег, по умолчанию `catalog`) или прямая ссылка на `catalog.json`.
  По умолчанию — `reproart/publii_modified`, релиз `catalog` (его публикует workflow «Publish catalog»).
  Настройки: `Documents/Publii/config/publii-plus-extensions.json`; токены — в связке ключей (`publii-plus-extensions`).
- **Приватный репозиторий** (как `publii_modified`) требует токен: GitHub → Settings → Developer settings →
  Fine-grained tokens → Generate: Repository access — только нужный репозиторий, Permissions → Contents: Read-only.
  Вставить в Sources → Edit → Access token.
- Для тестов: `PUBLII_PLUS_GITHUB_API` / `PUBLII_PLUS_GITHUB_WEB` подменяют адреса GitHub.


## Мастерская плагинов (расширение `plugin-workshop`)

- **Где**: Plugins приложения → блок «Plugin workshop» → «Open workshop».
- **Своя копия**: «Copy a plugin» — выбрать установленный плагин и имя папки копии (например `mermaidMine`).
  Копия появляется в списке плагинов как «… (my copy)» и включается для сайта как обычный плагин; оригинал не
  меняется и обновляется из каталога. Снимок оригинала хранится в `Documents/Publii/config/publii-plus-workshop/<id>/base`.
- **Новый плагин**: «New plugin» — имя папки, название, автор; создаётся рабочий шаблон (`plugin.json` + `main.js`).
- **Редактор**: дерево файлов, правка с подсветкой, Ctrl/Cmd+S, «Compare with original», новые файлы
  (например `front-assets/script.js`). Сохранение с ошибкой синтаксиса JS/JSON блокируется, ошибка показывается со строкой.
- **Без перезапуска**: Publii рендерит сайт в отдельном процессе и каждый раз загружает `main.js` заново —
  изменения применяются при следующем Preview/Sync. После правки `plugin.json` список плагинов обновляется сразу.
- **Check plugin**: проверка манифеста и синтаксиса всех файлов, загрузка `main.js` в отдельном процессе
  (тайм-аут 10 с), список зарегистрированных хуков и предупреждения о несуществующих именах хуков (например `postContent`).
- **Export changes (.diff)**: единый diff копии против исходной версии (`<плагин>-<версия>-changes.diff`) — его можно
  передать автору или применить к основной ветке плагина (`git apply`, путь `a/<файл>`). Переименование «(my copy)»
  в diff не попадает. **Export .zip** — архив `<id>_<версия>.zip` в формате каталога.
- **Журнал хуков**: включить «Record hook log», сделать Preview — для каждого плагина и хука видно число вызовов,
  сколько раз модификатор изменил значение, время (всего/максимум) и ошибки. Работает для всех включённых плагинов
  сайта. Журнал: `Documents/Publii/config/publii-plus-hook-log.json`; включение действует до перезапуска приложения.
