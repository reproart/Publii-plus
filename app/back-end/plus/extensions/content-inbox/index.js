/**
 * Publii Plus extension "content-inbox": Markdown files from a GitHub folder (or a local folder) become posts;
 * optionally the website is rendered and synced right after. Runs on demand, on a schedule while the app is
 * open, and from the AI agent. Renderer part: app/src/plus/extensions/content-inbox.
 */
const fs = require('fs');
const path = require('path');
const { createSource } = require('./sources');
const { createImporter } = require('./importer');
const { createPublisher } = require('./publisher');

const MIN_INTERVAL = 5;
const LOG_SIZE = 30;
const DEFAULTS = {
    enabled: false,
    source: 'github',
    repo: '',
    branch: 'main',
    folder: '',
    dir: '',
    defaultStatus: 'published',
    autoSync: true,
    intervalMinutes: 15,
    onDelete: 'keep',
    overwriteLocalEdits: false
};

function readJson (file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

function writeJson (file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function safeSite (site) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(String(site || '')) || String(site).startsWith('.')) throw new Error('Invalid website.');
    return site;
}

function sanitizeConfig (input = {}) {
    const c = { ...DEFAULTS };

    c.enabled = !!input.enabled;
    c.source = input.source === 'folder' ? 'folder' : 'github';
    c.repo = String(input.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    c.branch = String(input.branch || 'main').trim() || 'main';
    c.folder = String(input.folder || '').trim().replace(/^\/+|\/+$/g, '');
    c.dir = String(input.dir || '').trim();
    c.defaultStatus = input.defaultStatus === 'draft' ? 'draft' : 'published';
    c.autoSync = input.autoSync !== false;
    c.intervalMinutes = Math.max(MIN_INTERVAL, Math.min(24 * 60, parseInt(input.intervalMinutes, 10) || DEFAULTS.intervalMinutes));
    c.onDelete = input.onDelete === 'draft' ? 'draft' : 'keep';
    c.overwriteLocalEdits = !!input.overwriteLocalEdits;

    if (c.source === 'github' && c.repo && !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) throw new Error('Repository: use owner/name or a github.com link.');
    if (c.folder.split('/').includes('..')) throw new Error('Invalid folder.');
    if (c.source === 'folder' && c.dir && !path.isAbsolute(c.dir)) throw new Error('Choose the local folder (absolute path).');

    return c;
}

function createService ({ appDir, data, secrets, uploadImage, publisher, sites = () => [], notify = () => {}, apiBase = 'https://api.github.com', fetchImpl, now = () => Date.now() }) {
    const configFile = path.join(appDir, 'config', 'publii-plus-inbox.json');
    const stateFile = site => path.join(appDir, 'config', 'publii-plus-inbox', safeSite(site) + '.json');
    const importer = createImporter({ data, uploadImage, now });
    const running = new Set();
    let timer = null;

    const loadAll = () => readJson(configFile, { sites: {} });
    const config = site => ({ ...DEFAULTS, ...(loadAll().sites[safeSite(site)] || {}) });
    const loadState = site => ({ files: {}, log: [], ...readJson(stateFile(site), {}) });

    async function source (site, c = config(site)) {
        if (c.source === 'github' && !c.repo) throw new Error('Set the GitHub repository first.');
        if (c.source === 'folder' && !c.dir) throw new Error('Choose the local folder first.');

        const token = c.source === 'github' ? await secrets.get('inbox:' + site) : '';
        return createSource(c, { token, apiBase, fetchImpl });
    }

    function compactItems (items) {
        return items.filter(i => i.action !== 'unchanged').slice(0, 50)
            .map(i => ({ path: i.path, action: i.action, postId: i.postId || null, title: i.title || '', reason: i.reason || '' }));
    }

    async function run (site, { trigger = 'manual', publish } = {}) {
        safeSite(site);

        if (running.has(site)) throw new Error('The inbox of this website is already running.');

        running.add(site);

        const c = config(site);
        const state = loadState(site);
        const entry = { at: now(), trigger, created: 0, updated: 0, unpublished: 0, conflicts: 0, errors: 0, items: [], synced: false, syncError: '', error: '' };

        try {
            const summary = await importer.run({ site, source: await source(site, c), config: c, state });
            Object.assign(entry, {
                created: summary.created,
                updated: summary.updated,
                unpublished: summary.unpublished,
                conflicts: summary.conflicts,
                errors: summary.errors,
                items: compactItems(summary.items)
            });

            const shouldPublish = publish === undefined ? c.autoSync : !!publish;

            if (summary.changed && shouldPublish) {
                try {
                    const out = await publisher.publish(site);
                    entry.synced = true;
                    entry.syncIssues = !!out.issues;
                } catch (e) {
                    entry.syncError = e.message;
                }
            }
        } catch (e) {
            entry.error = e.message;
        } finally {
            running.delete(site);
            state.lastRunAt = entry.at;
            state.revision = (state.revision || 0) + 1;
            state.log = [entry, ...(state.log || [])].slice(0, LOG_SIZE);
            writeJson(stateFile(site), state);
        }

        if (entry.created || entry.updated || entry.unpublished || entry.error || entry.syncError || entry.errors) {
            const parts = [];

            if (entry.created) parts.push(`${entry.created} new`);
            if (entry.updated) parts.push(`${entry.updated} updated`);
            if (entry.unpublished) parts.push(`${entry.unpublished} unpublished`);
            if (entry.errors) parts.push(`${entry.errors} with errors`);
            if (entry.synced) parts.push('website synced');
            if (entry.syncError) parts.push('sync failed: ' + entry.syncError);
            if (entry.error) parts.push(entry.error);

            notify(`Content inbox – ${site}`, parts.join(', '));
        }

        return entry;
    }

    async function tick () {
        const at = now();

        for (const site of sites()) {
            let c;

            try { c = config(site); } catch (e) { continue; }

            if (!c.enabled || running.has(site)) continue;

            const last = loadState(site).lastRunAt || 0;

            if (at - last >= c.intervalMinutes * 60000) {
                await run(site, { trigger: 'schedule' }).catch(() => {});
            }
        }
    }

    return {
        status (site) {
            const c = config(site);
            const state = loadState(site);
            return {
                config: c,
                running: running.has(site),
                publishing: publisher.busy === site,
                canPublish: publisher.canPublish(site),
                imported: Object.values(state.files || {}).filter(f => !f.removedFromInbox && !f.removedInPublii).length,
                lastRunAt: state.lastRunAt || null,
                revision: state.revision || 0,
                log: state.log || []
            };
        },
        async hasToken (site) {
            return !!(await secrets.get('inbox:' + safeSite(site)));
        },
        async save (site, input, token) {
            const all = loadAll();
            all.sites = all.sites || {};
            all.sites[safeSite(site)] = sanitizeConfig(input);
            writeJson(configFile, all);

            if (typeof token === 'string') {
                if (token.trim()) await secrets.set('inbox:' + site, token.trim());
                else await secrets.remove('inbox:' + site);
            }

            return this.status(site);
        },
        /** Dry run: what the next import would do */
        async check (site) {
            const c = config(site);
            const state = loadState(site);
            const summary = await importer.run({ site, source: await source(site, c), config: c, state, dryRun: true });
            return { items: summary.items.map(i => ({ path: i.path, action: i.action, postId: i.postId || null, reason: i.reason || '' })) };
        },
        run,
        async publish (site) {
            return publisher.publish(safeSite(site));
        },
        /** Forget the mapping (files are imported again as new posts) */
        reset (site) {
            const state = loadState(site);
            state.files = {};
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
    id: 'content-inbox',
    name: 'Content inbox',
    createService,
    sanitizeConfig,
    DEFAULTS,
    /** The running service (used by the AI agent's tools) */
    getService: () => shared,

    register (ctx) {
        const app = ctx.appInstance;
        let passwordStorage = null;
        let safeStorage = null;
        let Notification = null;

        try { passwordStorage = require('../../../helpers/password-storage.js'); } catch (e) { /* tests */ }

        if (process.versions.electron) {
            try { ({ safeStorage, Notification } = require('electron')); } catch (e) { /* not available */ }
        }

        const { createSecretStore } = require('../../lib/secret-store');
        const { createPubliiData } = require('../ai-assistant/agent/publii-data');
        const { forkWorkerWithLogs } = require('../../../helpers/ipc.helper.js');
        const SiteLogs = require('../../../helpers/site-logs.js');
        const backEnd = path.join(__dirname, '..', '..', '..');
        const os = require('os');

        /** Publii's own image upload (copy + responsive versions), from a temporary file */
        async function uploadImage (site, postId, buffer, name, imageType) {
            const ImageUploaderEvents = require('../../../events/image-uploader.js');
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publii-inbox-'));
            const file = path.join(tmpDir, name.replace(/[^\w.-]+/g, '-'));

            try {
                fs.writeFileSync(file, buffer);
                const result = await ImageUploaderEvents.prototype.uploadImage.call(null, app, { id: postId, site, path: file, imageType });
                const saved = result && result.baseImage && result.baseImage.newPath;

                if (!saved) throw new Error(`Image "${name}" could not be processed.`);
                return path.basename(saved);
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }

        const publisher = createPublisher({
            app,
            forkWorker: (file, logsDir, logName) => forkWorkerWithLogs(path.join(backEnd, 'workers', file), logsDir, logName),
            logsDir: site => SiteLogs.getWorkerLogsDirectory(app, site),
            saveSyncStatus: site => {
                const SyncEvents = require('../../../events/sync.js');
                SyncEvents.prototype.saveSyncStatus.call({ app }, 'synced', site);
            }
        });

        const service = createService({
            appDir: app.appDir,
            data: createPubliiData({ app }),
            secrets: createSecretStore({ passwordStorage, safeStorage, service: 'publii-plus-inbox', secretsFile: path.join(app.appDir, 'config', 'publii-plus-inbox.secrets.json') }),
            uploadImage,
            publisher,
            sites: () => Object.keys(app.sites || {}),
            notify: (title, body) => {
                try {
                    if (Notification && Notification.isSupported()) new Notification({ title, body }).show();
                } catch (e) { /* notifications are optional */ }
            },
            apiBase: process.env.PUBLII_PLUS_GITHUB_API || 'https://api.github.com'
        });

        shared = service;
        service.start();

        ctx.handle('status', async (e, site) => ({ ...service.status(site), hasToken: await service.hasToken(site) }));
        ctx.handle('save', async (e, site, config, token) => ({ ...(await service.save(site, config, token)), hasToken: await service.hasToken(site) }));
        ctx.handle('check', (e, site) => service.check(site));
        ctx.handle('run', (e, site, options) => service.run(site, { trigger: 'manual', ...(options || {}) }));
        ctx.handle('publish', (e, site) => service.publish(site));
        ctx.handle('reset', (e, site) => service.reset(site));
        ctx.handle('choose-folder', async () => {
            const { dialog } = require('electron');
            const out = await dialog.showOpenDialog({ properties: ['openDirectory'] });
            return out.canceled ? '' : out.filePaths[0];
        });
    }
};
