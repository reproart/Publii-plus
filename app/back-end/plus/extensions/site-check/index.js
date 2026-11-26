/**
 * Publii Plus extension "site-check": checks the website before publishing.
 * Renders the website exactly like Sync (the "output" folder), then reads every page: broken links and anchors,
 * missing files, images without alt, heavy images and pages, titles, descriptions, indexing, canonical,
 * headings, mixed content; optionally every external link. The report is kept per website and shown in
 * Tools → Site check, in the Sync window and to the AI agent. Renderer part: app/src/plus/extensions/site-check.
 */
const fs = require('fs');
const path = require('path');
const { analyze } = require('./checks');
const { checkExternal } = require('./external');

const MAX_ISSUES = 3000;
const MAX_CACHE = 5000;

const EXTERNAL = {
    broken: ['error', 'external-broken'],
    error: ['warning', 'external-error'],
    unverified: ['notice', 'external-unverified'],
    skipped: ['notice', 'external-unverified'],
    redirect: ['notice', 'external-redirect']
};

function safeSite (site) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(String(site || '')) || String(site).startsWith('.')) throw new Error('Invalid website.');
    return site;
}

function readJson (file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

function writeJson (file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
}

function countBySeverity (issues) {
    const counts = { error: 0, warning: 0, notice: 0 };
    issues.forEach(i => { counts[i.severity]++; });
    return counts;
}

/** Posts and pages by slug, for "Edit" links in the report. */
function itemIndex (rows) {
    const bySlug = new Map();

    for (const r of rows) {
        if (/trashed|draft/.test(r.status || '')) continue;
        bySlug.set(String(r.slug).toLowerCase(), { type: /is-page/.test(r.status) ? 'page' : 'post', id: r.id, title: r.title, editor: r.editor || 'tinymce' });
    }

    return rel => {
        if (!rel || !/\.html?$/.test(rel)) return null;

        const clean = rel.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/, '').replace(/\/$/, '');
        const slug = clean.split('/').pop();

        return slug ? bySlug.get(slug.toLowerCase()) || null : null;
    };
}

/**
 * @param {object} o
 * @param {string} o.appDir
 * @param {function} o.siteConfig   site → site.config (domain, advanced, deployment)
 * @param {function} o.outputDir    site → rendered website folder
 * @param {function} o.render       site → Promise (render like Sync)
 * @param {function} o.items        site → [{ id, title, slug, status, editor }]
 */
function createService ({ appDir, siteConfig, outputDir, render, items = () => [], fetchImpl, now = () => Date.now() }) {
    const file = site => path.join(appDir, 'config', 'publii-plus-site-check', safeSite(site) + '.json');
    const running = new Map();
    const load = site => readJson(file(site), { report: null, cache: {} });

    function progress (site) {
        const r = running.get(site);
        return r ? { running: true, phase: r.phase, done: r.done, total: r.total } : { running: false };
    }

    async function run (site, { rerender = true, external = true } = {}) {
        safeSite(site);

        if (running.has(site)) throw new Error('The website is already being checked.');

        const controller = new AbortController();
        const state = { phase: rerender ? 'render' : 'scan', done: 0, total: 0, controller };
        const started = now();

        running.set(site, state);

        try {
            const config = siteConfig(site) || {};
            const dir = outputDir(site);

            if (rerender) await render(site);
            if (controller.signal.aborted) throw new Error('Cancelled.');
            if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error('The website has not been rendered yet – use "Check site" (renders it first).');

            state.phase = 'scan';

            const itemFor = itemIndex(items(site) || []);
            const result = analyze({
                outputDir: dir,
                domain: config.domain,
                siteNoIndex: !!(config.advanced && config.advanced.noIndexThisPage),
                itemFor
            });
            const issues = result.issues;
            const stored = load(site);
            const ext = { total: result.external.size, checked: false };

            if (external && result.external.size) {
                state.phase = 'external';
                state.total = result.external.size;

                const results = await checkExternal([...result.external.keys()], {
                    fetchImpl,
                    cache: stored.cache,
                    signal: controller.signal,
                    now,
                    onProgress: (done, total) => { state.done = done; state.total = total; }
                });

                ext.checked = true;

                for (const [url, res] of results) {
                    const map = EXTERNAL[res.state];

                    if (!map) continue;

                    ext[res.state] = (ext[res.state] || 0) + 1;

                    for (const ref of result.external.get(url)) {
                        issues.push({
                            severity: map[0],
                            check: map[1],
                            page: ref.page,
                            item: itemFor(ref.page),
                            target: url,
                            text: ref.text || '',
                            detail: res.detail + (res.finalUrl && res.state === 'redirect' ? ': ' + res.finalUrl : '') + (res.cached ? ' (checked earlier)' : '')
                        });
                    }
                }

                // keep the cache bounded
                const keys = Object.keys(stored.cache);

                if (keys.length > MAX_CACHE) keys.sort((a, b) => stored.cache[a].at - stored.cache[b].at).slice(0, keys.length - MAX_CACHE).forEach(k => delete stored.cache[k]);
            }

            const order = { error: 0, warning: 1, notice: 2 };
            issues.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check) || String(a.page).localeCompare(String(b.page)));

            const report = {
                at: now(),
                durationMs: now() - started,
                rendered: rerender,
                domain: config.domain || '',
                pages: result.pages,
                counts: countBySeverity(issues),
                external: ext,
                truncated: issues.length > MAX_ISSUES,
                issues: issues.slice(0, MAX_ISSUES)
            };

            writeJson(file(site), { report, cache: stored.cache });
            return report;
        } catch (e) {
            if (controller.signal.aborted) throw new Error('Cancelled.');
            throw e;
        } finally {
            running.delete(site);
        }
    }

    return {
        run,
        progress,
        cancel (site) {
            const r = running.get(site);
            if (r) r.controller.abort();
            return true;
        },
        report: site => load(site).report,
        /** Short summary for the Sync window and the Tools card */
        summary (site) {
            const report = load(site).report;
            return report ? { at: report.at, counts: report.counts, pages: report.pages, external: report.external.checked } : null;
        }
    };
}

let shared = null;

module.exports = {
    id: 'site-check',
    name: 'Site check',
    createService,
    itemIndex,
    getService: () => shared,

    register (ctx) {
        const app = ctx.appInstance;
        const { createPublisher } = require('../content-inbox/publisher');
        const { forkWorkerWithLogs } = require('../../../helpers/ipc.helper.js');
        const SiteLogs = require('../../../helpers/site-logs.js');
        const backEnd = path.join(__dirname, '..', '..', '..');
        const EDITORS = ['tinymce', 'blockeditor', 'markdown'];

        const publisher = createPublisher({
            app,
            forkWorker: (workerFile, logsDir, logName) => forkWorkerWithLogs(path.join(backEnd, 'workers', workerFile), logsDir, logName),
            logsDir: site => SiteLogs.getWorkerLogsDirectory(app, site)
        });

        const service = createService({
            appDir: app.appDir,
            siteConfig: site => app.sites && app.sites[site],
            outputDir: site => path.join(app.sitesDir, site, 'output'),
            render: site => publisher.render(site),
            items: site => {
                const db = app.getDbForSite(site);

                if (!db) return [];

                const editors = new Map(db.prepare("SELECT post_id, value FROM posts_additional_data WHERE key = '_core'").all().map(r => {
                    let editor = 'tinymce';

                    try { editor = JSON.parse(r.value).editor || editor; } catch (e) { /* default */ }

                    return [r.post_id, EDITORS.includes(editor) ? editor : 'tinymce'];
                }));

                return db.prepare('SELECT id, title, slug, status FROM posts').all().map(r => ({ ...r, editor: editors.get(r.id) || 'tinymce' }));
            }
        });

        shared = service;

        ctx.handle('run', (e, site, options) => service.run(site, options || {}));
        ctx.handle('progress', (e, site) => service.progress(site));
        ctx.handle('cancel', (e, site) => service.cancel(site));
        ctx.handle('report', (e, site) => service.report(site));
        ctx.handle('summary', (e, site) => service.summary(site));
        ctx.handle('open-external', (e, url) => {
            if (!/^https?:\/\//i.test(String(url))) return false;
            require('electron').shell.openExternal(url);
            return true;
        });
    }
};
