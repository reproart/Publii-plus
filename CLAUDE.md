# CLAUDE.md

Publii Plus — fork of GetPublii/Publii (Electron 43 + Vue 2.6, GPL-3.0). Read `FORK.md` first: it lists
every change to upstream files and the extension architecture.

## Rules

- New functionality goes into `app/back-end/plus/` and `app/src/plus/` as extensions. Touch upstream files only
  when unavoidable; mark each change with a `PUBLII-PLUS` comment and add it to the table in `FORK.md`.
- To show UI in a new place, add a single `<plus-slot name="..." :context="...">` to the upstream template
  (and list the slot in `FORK.md`). Do not edit upstream components beyond that.
- Main-process IPC for extensions only via `ctx.handle()` (channels `plus:<id>:<method>`).
- Never commit to branch `upstream` (mirror of official Publii, updated by the sync workflow).
- Commit directly to `master` and push (the owner asked for this). Only the sync workflow opens PRs.
- Keep app version = upstream version (`package.json`); the Publii Plus version lives in
  `app/back-end/plus/version.json` (bump it on releases).
- User-facing docs (`FORK.md`) are in Russian; code comments in English.

## Commands

```bash
npm ci && npm ci --prefix app        # ELECTRON_SKIP_BINARY_DOWNLOAD=1 if Electron is not needed
npm test                             # Node 22 (.nvmrc); includes app/back-end/plus and app/src/plus specs
npm run prepare-editor && npm run prod
npx electron-builder install-app-deps   # rebuild native modules before running Electron
```

Run the app headless for checks: `xvfb-run -a` + Playwright `_electron.launch({ args: ['<repo>/app', '--no-sandbox'] })`
(launch the `app/` dir, not `app/main.js`, so `productName` is applied).

Specs for Vue components follow the upstream pattern (vue-template-compiler + vm, render vnodes, no DOM).
