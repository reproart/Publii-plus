/**
 * Publii Plus extension "translations": posts of a main website are mirrored into language websites
 * (other Publii websites) with an AI translation – automatically while the app is open, or on demand.
 * The language websites are rendered and synced by the user. Renderer part: app/src/plus/extensions/translations.
 *
 * Settings: config/publii-plus-translations.json (per source website, no secrets);
 * state:    config/publii-plus-translations/<source>.json (mapping source post → translation, tag names, log).
 */
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./engine');
const { translatePost, languageName } = require('./translate');

const MIN_INTERVAL = 5;
const LOG_SIZE = 30;
const FAILURE_PAUSE = 6 * 3600000;
const DEFAULTS = { enabled: false, providerId: '', intervalMinutes: 30, maxPerRun: 10, targets: [] };

function readJson (file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

function writeJson (file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Language code of a website ("custom" = the code typed in Site settings) */
function siteLanguage (config = {}) {
    const code = config.language === 'custom' ? config.customLanguage : config.language;
    return String(code || '').trim();
}

function safeSite (site) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(String(site || '')) || String(site).startsWith('.')) throw new Error('Invalid website.');
    return site;
}

function sanitizeConfig (input = {}, { source, sites = {}, sourcesOf = () => [], hasTargets = () => false } = {}) {
    const c = { ...DEFAULTS };

    c.enabled = !!input.enabled;
    c.providerId = String(input.providerId || '').slice(0, 100);
    c.intervalMinutes = Math.max(MIN_INTERVAL, Math.min(24 * 60, parseInt(input.intervalMinutes, 10) || DEFAULTS.intervalMinutes));
    c.maxPerRun = Math.max(1, Math.min(200, parseInt(input.maxPerRun, 10) || DEFAULTS.maxPerRun));

    const seen = new Set();
    const lang = site => siteLanguage(sites[site]).toLowerCase();

    c.targets = (Array.isArray(input.targets) ? input.targets : []).map(t => ({
        site: String((t && t.site) || ''),
        glossary: String((t && t.glossary) || '').replace(/\r\n/g, '\n').trim().slice(0, 4000)
    })).filter(t => {
        if (!t.site || seen.has(t.site)) return false;

        seen.add(t.site);
        return true;
    });

    for (const t of c.targets) {
        safeSite(t.site);

        if (t.site === source) throw new Error('A website cannot be its own translation.');
        if (!sites[t.site]) throw new Error(`The website "${t.site}" does not exist.`);
        if (!lang(t.site)) throw new Error(`Set the language of "${t.site}" first (Site settings → Language).`);
        if (lang(t.site) === lang(source)) throw new Error(`"${t.site}" has the same language as this website (${lang(source)}).`);
        if (sourcesOf(t.site, source).length) throw new Error(`"${t.site}" is already a translation of "${sourcesOf(t.site, source)[0]}".`);
        if (hasTargets(t.site)) throw new Error(`"${t.site}" is a main website of other translations itself.`);
    }

    if (c.targets.length && sourcesOf(source, source).length) {
        throw new Error(`This website is a translation of "${sourcesOf(source, source)[0]}" – choose language websites only on the main website.`);
    }

    return c;
}

/**
 * @param {object} o
 * @param {string} o.appDir
 * @param {object} o.engine           createEngine(...)
 * @param {function} o.sites           () → { [site]: { language, displayName, name } }
 * @param {function} o.makeGenerate    (providerId, target) → Promise<(system, user, schema, schemaName) → { data, usage }>
 */
function createService ({ appDir, engine, sites = () => ({}), makeGenerate, translate = translatePost, notify = () => {}, now = () => Date.now() }) {
    const configFile = path.join(appDir, 'config', 'publii-plus-translations.json');
    const stateFile = site => path.join(appDir, 'config', 'publii-plus-translations', safeSite(site) + '.json');
    const running = new Map();
    let timer = null;

    const loadAll = () => readJson(configFile, { sites: {} });
    const config = site => ({ ...DEFAULTS, ...((loadAll().sites || {})[safeSite(site)] || {}) });
    const loadState = site => ({ posts: {}, tags: {}, errors: {}, log: [], ...readJson(stateFile(site), {}) });
    const language = site => siteLanguage(sites()[site]);

    /** Main websites that translate into this one */
    function sourcesOf (site, except) {
        const all = loadAll().sites || {};
        return Object.keys(all).filter(s => s !== except && (all[s].targets || []).some(t => t.site === site));
    }

    function existingTargets (c) {
        return c.targets.filter(t => sites()[t.site]);
    }

    function forceMap (only, force) {
        const map = {};

        if (force) for (const o of only || []) map[o.sourceId + '>' + o.target] = true;
        return map;
    }

    async function run (site, { trigger = 'manual', only = null, force = false, limit } = {}) {
        safeSite(site);

        if (running.has(site)) throw new Error('Translations of this website are already running.');

        const c = config(site);
        const targets = existingTargets(c);
        const entry = { at: now(), trigger, created: 0, updated: 0, meta: 0, linked: 0, unpublished: 0, errors: 0, links: 0, items: [], usage: { input: 0, output: 0 }, error: '' };
        const progress = { done: 0, total: 0, title: '', target: '', pieces: '' };

        running.set(site, progress);

        const state = loadState(site);

        try {
            if (!targets.length) throw new Error('Choose at least one language website.');

            const src = engine.source(site);
            const byId = new Map(src.posts.map(p => [p.id, p]));
            const wanted = only ? new Set(only.map(o => o.sourceId + '>' + o.target)) : null;
            const items = engine.plan({ src, targets: targets.map(t => t.site), state, force: forceMap(only, force) })
                .filter(i => i.action && (!wanted || wanted.has(i.sourceId + '>' + i.target)));
            const max = limit || c.maxPerRun;
            const translations = [];

            // copies without translation first (cheap), then translations up to the limit per run
            for (const item of items) {
                const post = byId.get(item.sourceId);
                const key = item.sourceId + '>' + item.target;

                try {
                    if (item.action === 'link') {
                        engine.setEntry(state, item.sourceId, item.target, engine.link({ target: item.target, post, item }));
                        entry.linked++;
                    } else if (item.action === 'meta') {
                        engine.setEntry(state, item.sourceId, item.target, engine.writeMetaOnly({ target: item.target, post, item, state }));
                        entry.meta++;
                    } else if (item.action === 'unpublish') {
                        engine.setEntry(state, item.sourceId, item.target, engine.unpublish({ target: item.target, entry: engine.entryOf(state, item.sourceId, item.target) }));
                        entry.unpublished++;
                    } else {
                        const failure = state.errors[key];

                        if (failure && failure.count >= 3 && now() - failure.at < FAILURE_PAUSE && !only) continue;
                        if (translations.length < max) translations.push(item);
                        continue;
                    }

                    entry.items.push({ sourceId: item.sourceId, title: item.title, target: item.target, action: item.action, targetId: item.targetId || null });
                } catch (e) {
                    entry.errors++;
                    entry.items.push({ sourceId: item.sourceId, title: item.title, target: item.target, action: item.action, error: e.message });
                }
            }

            progress.total = translations.length;

            const generators = {};

            for (const item of translations) {
                const post = byId.get(item.sourceId);
                const key = item.sourceId + '>' + item.target;
                const target = targets.find(t => t.site === item.target);

                progress.title = post.title;
                progress.target = item.target;
                progress.pieces = '';

                try {
                    generators[item.target] = generators[item.target] || await makeGenerate(c.providerId, item.target, entry.usage);

                    const translation = await translate({
                        post,
                        newTags: engine.newTags({ target: item.target, post, state }),
                        from: language(site),
                        to: language(item.target),
                        glossary: target.glossary,
                        generate: generators[item.target],
                        onProgress: p => { progress.pieces = `${p.done}/${p.total}`; }
                    });

                    entry.usage.input += translation.usage.input;
                    entry.usage.output += translation.usage.output;

                    const written = engine.write({ sourceSite: site, target: item.target, post, translation, item, state, refs: src.refs });

                    engine.setEntry(state, item.sourceId, item.target, written);
                    delete state.errors[key];
                    entry[item.action === 'create' ? 'created' : 'updated']++;
                    entry.items.push({ sourceId: item.sourceId, title: post.title, target: item.target, action: item.action, targetId: written.targetId, note: written.slugNote ? `slug: ${written.slugNote}` : '' });
                } catch (e) {
                    const failure = state.errors[key] || { count: 0 };

                    state.errors[key] = { count: failure.count + 1, at: now(), message: e.message };
                    entry.errors++;
                    entry.items.push({ sourceId: item.sourceId, title: post.title, target: item.target, action: item.action, error: e.message });

                    if (e.name === 'AbortError' || /No AI provider|API key|401|403/i.test(e.message)) {
                        entry.error = e.message;
                        break;
                    }
                }

                progress.done++;
                writeJson(stateFile(site), state);
            }

            for (const t of targets) {
                try {
                    entry.links += engine.fixPendingLinks({ target: t.site, state, refs: src.refs });
                } catch (e) { /* the next run tries again */ }
            }

            entry.remaining = Math.max(0, items.filter(i => i.action === 'create' || i.action === 'update').length - translations.length);
        } catch (e) {
            entry.error = e.message;
        } finally {
            running.delete(site);
            state.lastRunAt = entry.at;
            state.revision = (state.revision || 0) + 1;
            entry.items = entry.items.slice(0, 60);
            state.log = [entry, ...(state.log || [])].slice(0, LOG_SIZE);
            writeJson(stateFile(site), state);
        }

        if (entry.created || entry.updated || entry.unpublished || entry.errors || entry.error) {
            const parts = [];

            if (entry.created) parts.push(`${entry.created} new`);
            if (entry.updated) parts.push(`${entry.updated} updated`);
            if (entry.unpublished) parts.push(`${entry.unpublished} unpublished`);
            if (entry.errors) parts.push(`${entry.errors} failed`);
            if (entry.error) parts.push(entry.error);
            if (entry.created || entry.updated || entry.unpublished) parts.push('sync the language websites to publish them');

            notify(`Translations – ${site}`, parts.join(', '));
        }

        return entry;
    }

    async function tick () {
        const at = now();
        const all = loadAll().sites || {};

        for (const site of Object.keys(all)) {
            const c = { ...DEFAULTS, ...all[site] };

            if (!c.enabled || !c.targets.length || running.has(site) || !sites()[site]) continue;

            if (at - (loadState(site).lastRunAt || 0) >= c.intervalMinutes * 60000) {
                await run(site, { trigger: 'schedule' }).catch(() => {});
            }
        }
    }

    return {
        status (site) {
            safeSite(site);

            const c = config(site);
            const state = loadState(site);
            const all = sites();
            const websites = Object.keys(all).filter(s => s !== site).sort().map(s => ({
                site: s,
                name: all[s].displayName || all[s].name || s,
                language: siteLanguage(all[s]),
                languageName: languageName(siteLanguage(all[s])),
                mainOf: sourcesOf(s, site).length ? 'translation of ' + sourcesOf(s, site)[0] : (Object.keys((loadAll().sites || {})).includes(s) && ((loadAll().sites[s].targets || []).length) ? 'main website of translations' : '')
            }));
            let items = [];
            let planError = '';
            const targets = existingTargets(c);

            if (targets.length) {
                try {
                    items = engine.plan({ src: engine.source(site), targets: targets.map(t => t.site), state }).map(i => {
                        const failure = state.errors[i.sourceId + '>' + i.target];
                        const e = engine.entryOf(state, i.sourceId, i.target);

                        return {
                            sourceId: i.sourceId,
                            title: i.title,
                            target: i.target,
                            state: i.state,
                            action: i.action,
                            reason: i.reason,
                            targetId: i.targetId,
                            error: failure ? failure.message : '',
                            translatedAt: e ? e.translatedAt || e.linkedAt || null : null,
                            unresolved: e ? e.unresolved || 0 : 0
                        };
                    });
                } catch (e) {
                    planError = e.message;
                }
            }

            return {
                config: c,
                language: language(site),
                languageName: languageName(language(site)),
                translationOf: sourcesOf(site, site)[0] || '',
                websites,
                running: running.has(site),
                progress: running.get(site) || null,
                items,
                planError,
                lastRunAt: state.lastRunAt || null,
                revision: state.revision || 0,
                log: state.log || []
            };
        },
        save (site, input) {
            const all = loadAll();

            all.sites = all.sites || {};
            all.sites[safeSite(site)] = sanitizeConfig(input, {
                source: site,
                sites: sites(),
                sourcesOf,
                hasTargets: s => s !== site && !!((all.sites[s] || {}).targets || []).length
            });
            writeJson(configFile, all);
            return this.status(site);
        },
        run,
        /** Translate again even when the translation was changed in the target website (or linked) */
        overwrite (site, sourceId, target) {
            return run(site, { trigger: 'manual', only: [{ sourceId: Number(sourceId), target }], force: true, limit: 1 });
        },
        /** Forget a translation (deleted in the target website): the next run creates it again */
        forget (site, sourceId, target) {
            const state = loadState(site);

            engine.setEntry(state, Number(sourceId), target, null);
            delete state.errors[sourceId + '>' + target];
            state.revision = (state.revision || 0) + 1;
            writeJson(stateFile(site), state);
            return this.status(site);
        },
        start (intervalMs = 60000) {
            if (!timer) {
                timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
                if (timer.unref) timer.unref();
            }
        },
        stop () {
            clearInterval(timer);
            timer = null;
        },
        tick
    };
}

let shared = null;

module.exports = {
    id: 'translations',
    name: 'Translations',
    createService,
    sanitizeConfig,
    siteLanguage,
    DEFAULTS,
    getService: () => shared,

    register (ctx) {
        const app = ctx.appInstance;
        let Notification = null;

        if (process.versions.electron) {
            try { ({ Notification } = require('electron')); } catch (e) { /* not available */ }
        }

        const { createPubliiData } = require('../ai-assistant/agent/publii-data');
        const { generateStructured } = require('../ai-assistant/providers');
        const assistant = require('../ai-assistant');
        const DBUtils = require('../../../helpers/db.utils.js');
        const openDatabase = require('../../../helpers/db.connection.js');

        const engine = createEngine({
            app,
            data: createPubliiData({ app }),
            openDb: file => new DBUtils(openDatabase(file))
        });

        const service = createService({
            appDir: app.appDir,
            engine,
            sites: () => app.sites || {},
            makeGenerate: async (providerId, target) => {
                const store = assistant.getStore();

                if (!store) throw new Error('The AI Assistant extension is not loaded.');

                const { provider, apiKey } = await store.resolve(providerId);

                return async (system, user, schema, schemaName) => generateStructured({
                    config: provider,
                    apiKey,
                    system: assistant.withInstructions(system, store.getInstructions(target)),
                    user,
                    schema,
                    schemaName
                });
            },
            notify: (title, body) => {
                try {
                    if (Notification && Notification.isSupported()) new Notification({ title, body }).show();
                } catch (e) { /* notifications are optional */ }
            }
        });

        shared = service;
        service.start();

        ctx.handle('status', (e, site) => service.status(site));
        ctx.handle('save', (e, site, config) => service.save(site, config));
        ctx.handle('run', (e, site) => service.run(site, { trigger: 'manual' }));
        ctx.handle('overwrite', (e, site, sourceId, target) => service.overwrite(site, sourceId, target));
        ctx.handle('forget', (e, site, sourceId, target) => service.forget(site, sourceId, target));
    }
};
