/**
 * Publii Plus extension "plugin-workshop": own copies of plugins, new plugins, editing, checks,
 * diff/zip export and the render hook log.
 *
 * Copies live in Documents/Publii/plugins/<id>/ like any plugin (Publii renders with them).
 * Workshop data: Documents/Publii/config/publii-plus-workshop/<id>/
 *   meta.json  – { kind: 'copy' | 'new', origin: { id, name, version } | null, createdAt }
 *   base/      – snapshot of the original plugin at copy time (for "Compare" and "Export diff")
 * Publii's render worker loads main.js fresh for every render, so edits are used by the next render.
 */
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { createUnifiedDiff } = require('../../lib/unified-diff');
const { isKnownHook } = require('../../lib/publii-hooks');
const { validateContent } = require('../theme-editor');
const { validateExtensionDir } = require('../extensions-manager');

const EDITABLE = /\.(js|mjs|json|css|scss|html?|hbs|txt|md|svg|xml)$/i;
const VALID_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SKIP = new Set(['node_modules', '.git', '__MACOSX']);

const TEMPLATE_MAIN = `/**
 * __NAME__ – Publii plugin.
 * Hooks: https://github.com/reproart/publii_modified/blob/main/docs/plugin-api.md
 */
class Plugin {
    constructor (API, name, config) {
        this.API = API;
        this.name = name;
        this.config = config;
    }

    addModifiers () {
        // Runs on the text of every post; must return the (changed) HTML.
        this.API.addModifier('postText', (rendererInstance, html) => html, 1, this);
    }

    addInsertions () {
        // Adds code to <head> of every page.
        this.API.addInsertion('customHeadCode', () => '', 1, this);
    }
}

module.exports = Plugin;
`;

function walk (dir, prefix = '', out = []) {
    if (!fs.existsSync(dir)) return out;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;

        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, out);
        else if (entry.isFile() && EDITABLE.test(entry.name)) out.push(rel);
    }

    return out;
}

function safeRel (rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);

    if (!parts.length || parts.some(p => p === '..' || p === '.' || p.includes('\0'))) throw new Error('Invalid file path.');

    return parts.join('/');
}

function inside (base, rel) {
    const full = path.resolve(base, ...rel.split('/'));

    if (!full.startsWith(path.resolve(base) + path.sep)) throw new Error('Invalid file path.');

    return full;
}

function readIf (file) {
    return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
}

function readJson (file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function createService ({
    appDir,
    appVersion,
    reloadLists = () => {},
    blockingSites = () => [],
    showSaveDialog = async () => ({ canceled: true }),
    zipSync,
    runCheck,
    hookLogFile = path.join(appDir, 'config', 'publii-plus-hook-log.json'),
    env = process.env
}) {
    const pluginsDir = path.join(appDir, 'plugins');
    const workshopDir = path.join(appDir, 'config', 'publii-plus-workshop');

    const pluginDir = id => {
        if (!VALID_ID.test(String(id))) throw new Error('Invalid plugin name.');
        return path.join(pluginsDir, id);
    };
    const metaDir = id => path.join(workshopDir, id);
    const metaOf = id => readJson(path.join(metaDir(id), 'meta.json'));

    function requireWorkshop (id) {
        const meta = metaOf(id);

        if (!meta || !fs.existsSync(pluginDir(id))) throw new Error('This plugin is not a workshop plugin – make a copy first.');

        return meta;
    }

    function checkFree (id) {
        if (!VALID_ID.test(String(id))) throw new Error('Name: start with a letter; letters, digits, "-" and "_" only.');
        if (fs.existsSync(pluginDir(id))) throw new Error(`A plugin "${id}" already exists.`);
    }

    /** plugin.json of the copy with the original name, so the exported diff contains only real changes. */
    function forDiff (id, rel, content, meta) {
        if (rel !== 'plugin.json' || content === null || !meta.origin) return content;

        try {
            const json = JSON.parse(content);
            return content.replace(JSON.stringify(json.name), JSON.stringify(meta.origin.name));
        } catch (e) {
            return content;
        }
    }

    function diffOf (id) {
        const meta = requireWorkshop(id);
        const base = path.join(metaDir(id), 'base');
        const files = [...new Set([...walk(base), ...walk(pluginDir(id))])].sort();
        const parts = [];

        for (const rel of files) {
            const before = meta.kind === 'copy' ? readIf(inside(base, rel)) : null;
            const after = forDiff(id, rel, readIf(inside(pluginDir(id), rel)), meta);
            const text = createUnifiedDiff(before, after, { oldName: 'a/' + rel, newName: 'b/' + rel });

            if (text) parts.push(text);
        }

        return parts.join('');
    }

    const service = {
        list () {
            const installed = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir, { withFileTypes: true })
                .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
                .map(e => {
                    const json = readJson(path.join(pluginsDir, e.name, 'plugin.json')) || {};
                    const meta = metaOf(e.name);
                    return { id: e.name, name: json.name || e.name, version: json.version || '', workshop: !!meta, kind: meta ? meta.kind : null, origin: meta ? meta.origin : null };
                })
                .sort((a, b) => a.name.localeCompare(b.name)) : [];

            return { plugins: installed };
        },

        copy (sourceId, newId) {
            const source = pluginDir(sourceId);
            const sourceJson = readJson(path.join(source, 'plugin.json'));

            if (!sourceJson) throw new Error('The source plugin was not found.');

            checkFree(newId);

            const target = pluginDir(newId);
            const filter = src => !/(^|[\\/])(\.DS_Store|__MACOSX|\.git)$/.test(src);

            fs.rmSync(metaDir(newId), { recursive: true, force: true });
            fs.mkdirSync(metaDir(newId), { recursive: true });
            fs.cpSync(source, path.join(metaDir(newId), 'base'), { recursive: true, filter });
            fs.cpSync(source, target, { recursive: true, filter });

            const json = { ...sourceJson, name: `${sourceJson.name} (my copy)` };
            fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify(json, null, 2) + '\n');
            fs.writeFileSync(path.join(metaDir(newId), 'meta.json'), JSON.stringify({
                kind: 'copy',
                origin: { id: sourceId, name: sourceJson.name, version: sourceJson.version || '' },
                createdAt: new Date().toISOString()
            }, null, 2));

            reloadLists();
            return { ok: true, id: newId };
        },

        create (id, name, author) {
            checkFree(id);

            const title = String(name || '').trim().slice(0, 80) || id;
            // Publii lists plugins only when name, version, author, scope and minimumPubliiVersion are set
            const by = String(author || '').trim().slice(0, 80) || 'Publii Plus user';
            const target = pluginDir(id);

            fs.mkdirSync(target, { recursive: true });
            fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify({
                name: title,
                description: `${title} – created in the Publii Plus plugin workshop.`,
                license: 'GPL-3.0',
                author: by,
                version: '1.0.0',
                scope: 'site',
                minimumPubliiVersion: '0.46.0',
                config: []
            }, null, 2) + '\n');
            fs.writeFileSync(path.join(target, 'main.js'), TEMPLATE_MAIN.replace('__NAME__', title));
            fs.mkdirSync(metaDir(id), { recursive: true });
            fs.writeFileSync(path.join(metaDir(id), 'meta.json'), JSON.stringify({ kind: 'new', origin: null, createdAt: new Date().toISOString() }, null, 2));

            reloadLists();
            return { ok: true, id };
        },

        files (id) {
            const meta = requireWorkshop(id);
            const base = path.join(metaDir(id), 'base');
            const current = new Set(walk(pluginDir(id)));
            const original = meta.kind === 'copy' ? new Set(walk(base)) : new Set();
            const all = [...new Set([...current, ...original])].sort((a, b) => a.localeCompare(b));

            return {
                meta,
                files: all.map(rel => {
                    const now = current.has(rel) ? readIf(inside(pluginDir(id), rel)) : null;
                    const was = original.has(rel) ? readIf(inside(base, rel)) : null;
                    const changed = meta.kind === 'copy' && forDiff(id, rel, now, meta) !== was;

                    return { path: rel, changed, added: meta.kind === 'copy' && was === null, deleted: now === null };
                }).filter(f => !f.deleted)
            };
        },

        read (id, rel) {
            const meta = requireWorkshop(id);
            const safe = safeRel(rel);
            const content = readIf(inside(pluginDir(id), safe));

            if (content === null) throw new Error('File not found.');

            const original = meta.kind === 'copy' ? readIf(inside(path.join(metaDir(id), 'base'), safe)) : null;
            return { path: safe, content, original: forDiff(id, safe, original, { origin: null }) };
        },

        save (id, rel, content) {
            requireWorkshop(id);

            const safe = safeRel(rel);

            if (!EDITABLE.test(safe)) throw new Error('This file type cannot be edited.');

            const check = validateContent(safe, content);

            if (check.errors.length) return { ok: false, ...check };

            const file = inside(pluginDir(id), safe);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, String(content), 'utf8');

            if (safe === 'plugin.json') reloadLists();

            return { ok: true, ...check };
        },

        createFile (id, rel) {
            requireWorkshop(id);

            const safe = safeRel(rel);

            if (!EDITABLE.test(safe)) throw new Error('Use one of: .js .json .css .html .hbs .txt .md .svg');

            const file = inside(pluginDir(id), safe);

            if (fs.existsSync(file)) throw new Error('The file already exists.');

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '');
            return { ok: true, path: safe };
        },

        deleteFile (id, rel) {
            requireWorkshop(id);

            const safe = safeRel(rel);

            if (safe === 'plugin.json' || safe === 'main.js') throw new Error('plugin.json and main.js are required.');

            fs.rmSync(inside(pluginDir(id), safe), { force: true });
            return { ok: true };
        },

        /** Manifest + syntax of every JS/JSON file + hooks registered by main.js (in a separate process). */
        async check (id) {
            requireWorkshop(id);

            const dir = pluginDir(id);
            const result = validateExtensionDir(dir, { appVersion });
            const errors = [...result.errors];
            const warnings = [...result.warnings];

            for (const rel of walk(dir).filter(f => /\.(js|json)$/i.test(f))) {
                const issues = validateContent(rel, fs.readFileSync(inside(dir, rel), 'utf8'));
                issues.errors.forEach(e => errors.push(`${rel}${e.line ? ':' + e.line : ''} – ${e.message}`));
                issues.warnings.forEach(w => warnings.push(`${rel} – ${w.message}`));
            }

            let hooks = null;

            if (!errors.length && runCheck) {
                const out = await runCheck(dir);

                if (!out.ok) {
                    errors.push('main.js failed to load: ' + out.error);
                } else {
                    hooks = out.registered;

                    for (const type of ['modifiers', 'insertions', 'events']) {
                        for (const name of hooks[type]) {
                            if (!isKnownHook(type, name)) warnings.push(`Unknown ${type.slice(0, -1)} "${name}" – Publii never calls it (typo?).`);
                        }
                    }

                    if (!hooks.modifiers.length && !hooks.insertions.length && !hooks.events.length) warnings.push('The plugin registers no hooks.');
                }
            }

            return { ok: !errors.length, errors, warnings, hooks };
        },

        diff: diffOf,

        async exportDiff (id) {
            const meta = requireWorkshop(id);

            if (meta.kind !== 'copy') throw new Error('Export a new plugin as .zip instead.');

            const text = diffOf(id);

            if (!text) return { ok: false, message: 'No changes compared with the original.' };

            const result = await showSaveDialog({
                title: 'Export plugin changes',
                defaultPath: `${meta.origin.id}-${meta.origin.version || 'x'}-changes.diff`,
                filters: [{ name: 'Diff', extensions: ['diff', 'patch'] }]
            });

            if (!result || result.canceled || !result.filePath) return { ok: false, canceled: true };

            fs.writeFileSync(result.filePath, text, 'utf8');
            return { ok: true, filePath: result.filePath, files: (text.match(/^\+\+\+ /gm) || []).length };
        },

        async exportZip (id) {
            requireWorkshop(id);

            const dir = pluginDir(id);
            const json = readJson(path.join(dir, 'plugin.json')) || {};
            const entries = {};
            const add = (abs, rel) => {
                for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
                    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
                    if (e.isDirectory()) add(path.join(abs, e.name), `${rel}/${e.name}`);
                    else entries[`${rel}/${e.name}`] = new Uint8Array(fs.readFileSync(path.join(abs, e.name)));
                }
            };

            add(dir, id);

            const result = await showSaveDialog({
                title: 'Export plugin',
                defaultPath: `${id}_${json.version || '1.0.0'}.zip`,
                filters: [{ name: 'ZIP', extensions: ['zip'] }]
            });

            if (!result || result.canceled || !result.filePath) return { ok: false, canceled: true };

            fs.writeFileSync(result.filePath, Buffer.from(zipSync(entries)));
            return { ok: true, filePath: result.filePath };
        },

        remove (id) {
            requireWorkshop(id);

            const sites = blockingSites(id);

            if (sites.length) throw new Error(`Close the settings of this plugin first (open in: ${sites.join(', ')}).`);

            fs.rmSync(pluginDir(id), { recursive: true, force: true });
            fs.rmSync(metaDir(id), { recursive: true, force: true });
            reloadLists();
            return { ok: true };
        },

        hookLogState () {
            return { enabled: env.PUBLII_PLUS_HOOK_LOG === hookLogFile, log: readJson(hookLogFile) };
        },

        setHookLog (enabled) {
            if (enabled) env.PUBLII_PLUS_HOOK_LOG = hookLogFile;
            else delete env.PUBLII_PLUS_HOOK_LOG;

            return service.hookLogState();
        },

        clearHookLog () {
            fs.rmSync(hookLogFile, { force: true });
            return service.hookLogState();
        }
    };

    return service;
}

/** Load main.js in a child process (plain Node via ELECTRON_RUN_AS_NODE) with a timeout. */
function runCheckInChild (pluginDir, timeoutMs = 10000) {
    return new Promise(resolve => {
        let done = false;
        const child = childProcess.fork(path.join(__dirname, 'check-worker.js'), [], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        const finish = out => {
            if (done) return;

            done = true;
            clearTimeout(timer);

            try { child.kill(); } catch (e) { /* already exited */ }

            resolve(out);
        };
        const timer = setTimeout(() => finish({ ok: false, error: `main.js did not finish loading within ${timeoutMs / 1000} s.` }), timeoutMs);

        child.on('message', finish);
        child.on('error', e => finish({ ok: false, error: e.message }));
        child.on('exit', code => finish({ ok: false, error: `The check process exited (code ${code}).` }));
        child.send({ pluginDir });
    });
}

module.exports = {
    id: 'plugin-workshop',
    name: 'Plugin workshop',
    createService,
    runCheckInChild,

    register (ctx) {
        const app = ctx.appInstance;
        let dialog = null;

        if (process.versions.electron) {
            try { dialog = require('electron').dialog; } catch (e) { /* not available */ }
        }

        const Plugins = require('../../../plugins.js');
        const getPluginSettingsLocks = require('../../../helpers/plugin-settings-locks.js');
        const fflate = require('fflate');

        const service = createService({
            appDir: app.appDir,
            appVersion: require(path.join(__dirname, '..', '..', '..', '..', 'package.json')).version,
            zipSync: entries => fflate.zipSync(entries),
            runCheck: dir => runCheckInChild(dir),
            showSaveDialog: options => (dialog ? dialog.showSaveDialog(options) : Promise.resolve({ canceled: true })),
            blockingSites: id => getPluginSettingsLocks(app).blockingSites(id),
            reloadLists: () => {
                app.plugins = new Plugins(app.appDir, app.sitesDir).loadPlugins();
                app.notifyExtensionsChanged();
            }
        });

        ctx.handle('list', () => service.list());
        ctx.handle('copy', (e, sourceId, newId) => service.copy(sourceId, newId));
        ctx.handle('create', (e, id, name, author) => service.create(id, name, author));
        ctx.handle('files', (e, id) => service.files(id));
        ctx.handle('read', (e, id, rel) => service.read(id, rel));
        ctx.handle('save', (e, id, rel, content) => service.save(id, rel, content));
        ctx.handle('create-file', (e, id, rel) => service.createFile(id, rel));
        ctx.handle('delete-file', (e, id, rel) => service.deleteFile(id, rel));
        ctx.handle('check', (e, id) => service.check(id));
        ctx.handle('diff', (e, id) => service.diff(id));
        ctx.handle('export-diff', (e, id) => service.exportDiff(id));
        ctx.handle('export-zip', (e, id) => service.exportZip(id));
        ctx.handle('remove', (e, id) => service.remove(id));
        ctx.handle('hook-log', () => service.hookLogState());
        ctx.handle('hook-log:set', (e, enabled) => service.setHookLog(!!enabled));
        ctx.handle('hook-log:clear', () => service.clearHookLog());
    }
};
