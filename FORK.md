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

Доступные слоты: `about`.
