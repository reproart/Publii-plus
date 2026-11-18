/**
 * Publii Plus extension "extensions-manager": catalogs of plugins/themes, one-click install and
 * update, install from a URL or GitHub repository, validation before installing.
 *
 * Catalog sources (Documents/Publii/config/publii-plus-extensions.json):
 *   { id, name, type: 'github', owner, repo, tag }   – release assets (private repos: token in keychain)
 *   { id, name, type: 'url', url }                   – direct catalog.json URL (files relative to it)
 * Catalog format: see publii_modified/tools/catalog.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createSecretStore } = require('../../lib/secret-store');

const KEYCHAIN_SERVICE = 'publii-plus-extensions';
const MAX_DOWNLOAD = 150 * 1024 * 1024;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DEFAULT_SOURCES = [
    { id: 'publii-modified', name: 'publii_modified (reproart)', type: 'github', owner: 'reproart', repo: 'publii_modified', tag: 'catalog' }
];

function defaultFetch () {
    if (process.versions.electron) {
        try {
            const { net } = require('electron');
            if (net && net.fetch) return net.fetch.bind(net);
        } catch (e) { /* not in Electron */ }
    }

    return globalThis.fetch;
}

/** "1.10.0" > "1.9.2"; non-numeric parts compare as 0. */
function compareVersions (a, b) {
    const pa = String(a || '0').split(/[.+-]/).map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split(/[.+-]/).map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }

    return 0;
}

/** "publii-mermaid-support-plugin" -> "mermaidSupport" (install id suggestion for repository archives). */
function idFromRepoName (name) {
    const words = String(name || '').toLowerCase()
        .replace(/^publii[-_]/, '').replace(/[-_](publii[-_])?(plugin|theme)$/, '')
        .split(/[^a-z0-9]+/).filter(Boolean);

    return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('') || 'extension';
}

function readJsonIf (file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

/**
 * Checks before installing (same required fields as Publii's own validators + files that must exist).
 * Returns { type, meta, errors, warnings }.
 */
function validateExtensionDir (dir, { appVersion } = {}) {
    const errors = [];
    const warnings = [];
    const pluginJson = path.join(dir, 'plugin.json');
    const themeJson = path.join(dir, 'config.json');
    let type = null;
    let meta = null;

    if (fs.existsSync(pluginJson)) {
        type = 'plugin';
        meta = readJsonIf(pluginJson);

        if (!meta) {
            errors.push('plugin.json is not valid JSON.');
        } else {
            for (const key of ['name', 'version', 'author', 'scope', 'minimumPubliiVersion']) {
                if (!meta[key]) errors.push(`plugin.json: "${key}" is missing – Publii would not show the plugin.`);
            }

            if (meta.scope === 'site' && !fs.existsSync(path.join(dir, 'main.js'))) errors.push('main.js is missing.');

            for (const asset of (meta.assets && Array.isArray(meta.assets.front) ? meta.assets.front : [])) {
                if (!fs.existsSync(path.join(dir, 'front-assets', ...String(asset).split('/')))) errors.push(`Front asset front-assets/${asset} is missing.`);
            }

            if (meta.config !== undefined && !Array.isArray(meta.config)) errors.push('plugin.json: "config" must be an array.');
            if (!meta.description) warnings.push('No description.');
        }
    } else if (fs.existsSync(themeJson)) {
        type = 'theme';
        meta = readJsonIf(themeJson);

        if (!meta) {
            errors.push('config.json is not valid JSON.');
        } else {
            for (const key of ['name', 'version', 'author']) {
                if (!meta[key]) errors.push(`config.json: "${key}" is missing – Publii would not show the theme.`);
            }

            for (const file of ['index.hbs', 'post.hbs']) {
                if (!fs.existsSync(path.join(dir, file))) warnings.push(`${file} is missing.`);
            }
        }
    } else {
        errors.push('Neither plugin.json nor config.json found – this is not a Publii plugin or theme.');
    }

    if (meta && meta.minimumPubliiVersion && appVersion && compareVersions(meta.minimumPubliiVersion, appVersion) > 0) {
        errors.push(`Requires Publii ${meta.minimumPubliiVersion} or newer (this is ${appVersion}).`);
    }

    return { type, meta, errors, warnings };
}

/** Locate the extension folder inside an extracted archive. */
function findExtensionRoot (extractDir) {
    const isExt = dir => fs.existsSync(path.join(dir, 'plugin.json')) || fs.existsSync(path.join(dir, 'config.json'));

    if (isExt(extractDir)) return { dir: extractDir, folder: null };

    const dirs = fs.readdirSync(extractDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map(e => e.name);

    if (dirs.length === 1 && isExt(path.join(extractDir, dirs[0]))) {
        return { dir: path.join(extractDir, dirs[0]), folder: dirs[0] };
    }

    throw new Error('The archive must contain one plugin or theme folder (with plugin.json or config.json).');
}

function createService ({
    appDir,
    getSitesDir = () => null,
    appVersion,
    fetchImpl,
    extractZip,
    secrets,
    reloadLists = () => {},
    blockingSites = () => [],
    apiBase = 'https://api.github.com',
    githubBase = 'https://github.com',
    tmpDir = os.tmpdir()
}) {
    const configFile = path.join(appDir, 'config', 'publii-plus-extensions.json');
    const inspected = new Map();
    let busy = false;

    const fetchFn = () => fetchImpl || defaultFetch();

    function loadConfig () {
        const data = readJsonIf(configFile);
        return { sources: data && Array.isArray(data.sources) ? data.sources : DEFAULT_SOURCES.map(s => ({ ...s })) };
    }

    function saveConfig (config) {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }

    async function request (url, { token, accept = 'application/json', binary = false } = {}) {
        const headers = { Accept: accept, 'User-Agent': 'Publii-Plus' };

        if (token) headers.Authorization = 'Bearer ' + token;

        let response;

        try {
            response = await fetchFn()(url, { headers, redirect: 'follow' });
        } catch (e) {
            throw new Error(`Cannot connect to ${new URL(url).host}: ${e.cause && e.cause.code ? e.cause.code : e.message}`);
        }

        if (!response.ok) {
            const hint = response.status === 404 ? ' – not found, or the repository is private and needs a token.'
                : response.status === 401 || response.status === 403 ? ' – check the access token.' : '';
            throw new Error(`HTTP ${response.status} for ${url}${hint}`);
        }

        if (!binary) return response.json();

        const length = Number(response.headers.get('content-length') || 0);

        if (length > MAX_DOWNLOAD) throw new Error('The file is too large.');

        const buffer = Buffer.from(await response.arrayBuffer());

        if (buffer.length > MAX_DOWNLOAD) throw new Error('The file is too large.');

        return buffer;
    }

    function installedVersion (type, id) {
        const file = type === 'plugin' ? path.join(appDir, 'plugins', id, 'plugin.json') : path.join(appDir, 'themes', id, 'config.json');
        const meta = readJsonIf(file);
        return meta ? String(meta.version || '') : null;
    }

    function itemStatus (item) {
        const installed = installedVersion(item.type, item.id);

        if (installed === null) return { installed: null, status: 'available' };

        const cmp = compareVersions(item.version, installed);
        return { installed, status: cmp > 0 ? 'update' : cmp < 0 ? 'newer-installed' : 'installed' };
    }

    /** Catalog of one source + download locations of its files. */
    async function readCatalog (source) {
        const token = await secrets.get(source.id);

        if (source.type === 'github') {
            const release = await request(`${apiBase}/repos/${source.owner}/${source.repo}/releases/tags/${encodeURIComponent(source.tag || 'catalog')}`, { token, accept: 'application/vnd.github+json' });
            const assets = new Map((release.assets || []).map(a => [a.name, a.url]));

            if (!assets.has('catalog.json')) throw new Error('The release has no catalog.json.');

            const catalog = JSON.parse((await request(assets.get('catalog.json'), { token, accept: 'application/octet-stream', binary: true })).toString('utf8'));
            return { catalog, fileUrl: file => assets.get(file), token, accept: 'application/octet-stream' };
        }

        if (source.type === 'url') {
            const catalog = await request(source.url, { token });
            return { catalog, fileUrl: file => new URL(file, source.url).toString(), token, accept: 'application/octet-stream' };
        }

        throw new Error('Unknown source type.');
    }

    function sourceById (id) {
        const source = loadConfig().sources.find(s => s.id === id);

        if (!source) throw new Error('Unknown catalog source.');

        return source;
    }

    async function extractToTemp (buffer, nameHint) {
        const base = fs.mkdtempSync(path.join(tmpDir, 'publii-plus-ext-'));
        const zipFile = path.join(base, (String(nameHint || 'extension').replace(/[^A-Za-z0-9_.-]/g, '_') || 'extension') + '.zip');
        const target = path.join(base, 'extracted');

        fs.writeFileSync(zipFile, buffer);

        try {
            extractZip(zipFile, target);
        } catch (e) {
            fs.rmSync(base, { recursive: true, force: true });
            throw new Error('Cannot unpack the archive: ' + e.message);
        }

        return { base, target };
    }

    /** Copy a validated folder into Publii's plugins/themes folder and refresh Publii's lists. */
    function installDir (type, id, dir) {
        if (!VALID_ID.test(id)) throw new Error('Invalid install name. Use letters, digits, "-", "_" or ".".');

        if (type === 'plugin') {
            const sites = blockingSites(id);

            if (sites.length) throw new Error(`Close the settings of this plugin first (open in: ${sites.join(', ')}).`);
        }

        const parent = path.join(appDir, type === 'plugin' ? 'plugins' : 'themes');
        const target = path.join(parent, id);
        const existed = fs.existsSync(target);
        const staging = path.join(parent, `__PLUS_STAGING__${id}`);

        fs.mkdirSync(parent, { recursive: true });
        fs.rmSync(staging, { recursive: true, force: true });
        fs.cpSync(dir, staging, {
            recursive: true,
            filter: src => !/(^|[\\/])(__MACOSX|\.DS_Store|\.git)$/.test(src)
        });
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(staging, target);
        reloadLists(type);

        return { ok: true, type, id, status: existed ? 'updated' : 'added' };
    }

    async function withLock (fn) {
        if (busy) throw new Error('Another installation is running.');

        busy = true;

        try {
            return await fn();
        } finally {
            busy = false;
        }
    }

    return {
        compareVersions,

        async sources () {
            const config = loadConfig();
            const out = [];

            for (const s of config.sources) out.push({ ...s, hasToken: !!(await secrets.get(s.id)) });

            return out;
        },

        async saveSource (input) {
            const config = loadConfig();
            const type = input.type === 'url' ? 'url' : 'github';
            const source = { id: input.id && /^[a-z0-9-]{1,64}$/.test(input.id) ? input.id : 'src-' + crypto.randomBytes(4).toString('hex'), name: String(input.name || '').trim().slice(0, 80), type };

            if (type === 'github') {
                source.owner = String(input.owner || '').trim();
                source.repo = String(input.repo || '').trim();
                source.tag = String(input.tag || 'catalog').trim() || 'catalog';

                if (!/^[A-Za-z0-9_.-]+$/.test(source.owner) || !/^[A-Za-z0-9_.-]+$/.test(source.repo)) throw new Error('Enter the GitHub owner and repository.');
                if (!source.name) source.name = `${source.owner}/${source.repo}`;
            } else {
                try {
                    const u = new URL(String(input.url || '').trim());
                    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
                    source.url = u.toString();
                } catch (e) {
                    throw new Error('Enter a valid catalog.json URL.');
                }

                if (!source.name) source.name = new URL(source.url).host;
            }

            const index = config.sources.findIndex(s => s.id === source.id);

            if (index >= 0) config.sources[index] = source;
            else config.sources.push(source);

            if (typeof input.token === 'string') {
                if (input.token.trim()) await secrets.set(source.id, input.token.trim());
                else await secrets.remove(source.id);
            }

            saveConfig(config);
            return source;
        },

        async removeSource (id) {
            const config = loadConfig();
            config.sources = config.sources.filter(s => s.id !== id);
            saveConfig(config);
            await secrets.remove(id);
            return true;
        },

        /** All sources merged; per item: install status. Errors of one source do not hide the others. */
        async catalog () {
            const results = [];

            for (const source of loadConfig().sources) {
                try {
                    const { catalog } = await readCatalog(source);
                    const items = (catalog.items || []).filter(i => i && VALID_ID.test(i.id) && (i.type === 'plugin' || i.type === 'theme'));

                    results.push({
                        source: { id: source.id, name: source.name },
                        generated: catalog.generated || null,
                        items: items.map(i => ({ ...i, sourceId: source.id, ...itemStatus(i) }))
                    });
                } catch (e) {
                    results.push({ source: { id: source.id, name: source.name }, error: e.message, items: [] });
                }
            }

            return results;
        },

        /** Install or update one catalog item (size + SHA-256 verified). */
        installFromCatalog (sourceId, itemId) {
            return withLock(async () => {
                const source = sourceById(sourceId);
                const { catalog, fileUrl, token, accept } = await readCatalog(source);
                const item = (catalog.items || []).find(i => i.id === itemId);

                if (!item) throw new Error('The item is no longer in the catalog.');

                const url = fileUrl(item.file);

                if (!url) throw new Error(`${item.file} is missing in the catalog release.`);

                const buffer = await request(url, { token, accept, binary: true });

                if (item.size && buffer.length !== item.size) throw new Error('Downloaded size does not match the catalog.');
                if (item.sha256 && crypto.createHash('sha256').update(buffer).digest('hex') !== item.sha256) throw new Error('Checksum mismatch – the download is corrupted or was changed.');

                const { base, target } = await extractToTemp(buffer, item.file);

                try {
                    const root = findExtensionRoot(target);
                    const check = validateExtensionDir(root.dir, { appVersion });

                    if (check.errors.length) throw new Error(check.errors.join(' '));
                    if (check.type !== item.type) throw new Error(`The archive contains a ${check.type}, the catalog says ${item.type}.`);

                    return { ...installDir(item.type, item.id, root.dir), version: check.meta.version, warnings: check.warnings };
                } finally {
                    fs.rmSync(base, { recursive: true, force: true });
                }
            });
        },

        /**
         * Step 1 of installing from a link: download, unpack and check. Accepts a .zip URL or a GitHub
         * repository URL (https://github.com/owner/repo[/tree/branch]).
         */
        inspectUrl (rawUrl) {
            return withLock(async () => {
                let url;

                try {
                    url = new URL(String(rawUrl || '').trim());
                    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
                } catch (e) {
                    throw new Error('Enter an http(s) link to a .zip file or a GitHub repository.');
                }

                let downloadUrl = url.toString();
                let repoName = '';
                const gh = url.host === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?\/?$/);

                if (gh) {
                    // archive link instead of the REST API: no API rate limit for public repositories
                    repoName = gh[2];
                    downloadUrl = `${githubBase}/${gh[1]}/${gh[2]}/archive/${gh[3] ? 'refs/heads/' + encodeURIComponent(gh[3]) : 'HEAD'}.zip`;
                }

                const buffer = await request(downloadUrl, { binary: true, accept: 'application/octet-stream' });
                const { base, target } = await extractToTemp(buffer, repoName || path.basename(url.pathname));

                try {
                    const root = findExtensionRoot(target);
                    const check = validateExtensionDir(root.dir, { appVersion });
                    const fromFile = path.basename(url.pathname).replace(/\.zip$/i, '').replace(/_\d+(\.\d+)*$/, '');
                    let suggestedId = root.folder && !repoName ? root.folder : (repoName ? idFromRepoName(repoName) : fromFile);

                    if (!VALID_ID.test(suggestedId)) suggestedId = idFromRepoName(suggestedId);

                    const token = crypto.randomBytes(8).toString('hex');
                    inspected.set(token, { base, dir: root.dir, type: check.type });

                    return {
                        token,
                        type: check.type,
                        name: check.meta ? check.meta.name : '',
                        version: check.meta ? check.meta.version : '',
                        description: check.meta ? check.meta.description || '' : '',
                        suggestedId,
                        installedVersion: check.type ? installedVersion(check.type, suggestedId) : null,
                        errors: check.errors,
                        warnings: check.warnings
                    };
                } catch (e) {
                    fs.rmSync(base, { recursive: true, force: true });
                    throw e;
                }
            });
        },

        /** Step 2: install what inspectUrl() unpacked under the chosen name. */
        installInspected (token, id) {
            return withLock(async () => {
                const entry = inspected.get(token);

                if (!entry) throw new Error('Inspect the link again.');

                try {
                    const check = validateExtensionDir(entry.dir, { appVersion });

                    if (check.errors.length) throw new Error(check.errors.join(' '));

                    return { ...installDir(check.type, String(id || '').trim(), entry.dir), version: check.meta.version, warnings: check.warnings };
                } finally {
                    inspected.delete(token);
                    fs.rmSync(entry.base, { recursive: true, force: true });
                }
            });
        },

        cancelInspected (token) {
            const entry = inspected.get(token);

            if (entry) {
                inspected.delete(token);
                fs.rmSync(entry.base, { recursive: true, force: true });
            }

            return true;
        }
    };
}

module.exports = {
    id: 'extensions-manager',
    name: 'Extensions manager',
    createService,
    compareVersions,
    idFromRepoName,
    validateExtensionDir,
    findExtensionRoot,
    DEFAULT_SOURCES,

    register (ctx) {
        const app = ctx.appInstance;
        let passwordStorage = null;
        let safeStorage = null;

        try { passwordStorage = require('../../../helpers/password-storage.js'); } catch (e) { /* tests */ }

        if (process.versions.electron) {
            try { safeStorage = require('electron').safeStorage; } catch (e) { /* not available */ }
        }

        const ZipHelper = require('../../../helpers/zip.helper.js');
        const Plugins = require('../../../plugins.js');
        const Themes = require('../../../themes.js');
        const getPluginSettingsLocks = require('../../../helpers/plugin-settings-locks.js');
        const appVersion = require(path.join(__dirname, '..', '..', '..', '..', 'package.json')).version;

        const service = createService({
            appDir: app.appDir,
            // test hook: point GitHub sources at a fake API (default https://api.github.com)
            apiBase: process.env.PUBLII_PLUS_GITHUB_API || undefined,
            githubBase: process.env.PUBLII_PLUS_GITHUB_WEB || undefined,
            getSitesDir: () => app.sitesDir,
            appVersion,
            extractZip: (zip, target) => ZipHelper.extractZipSafely(zip, target),
            secrets: createSecretStore({ passwordStorage, safeStorage, service: KEYCHAIN_SERVICE, secretsFile: path.join(app.appDir, 'config', 'publii-plus-extensions.secrets.json') }),
            blockingSites: id => getPluginSettingsLocks(app).blockingSites(id),
            reloadLists: type => {
                if (type === 'plugin') app.plugins = new Plugins(app.appDir, app.sitesDir).loadPlugins();
                else app.themes = new Themes(app).loadThemes();

                app.notifyExtensionsChanged();
            }
        });

        ctx.handle('sources', () => service.sources());
        ctx.handle('sources:save', (event, input) => service.saveSource(input));
        ctx.handle('sources:remove', (event, id) => service.removeSource(id));
        ctx.handle('catalog', () => service.catalog());
        ctx.handle('install', (event, sourceId, itemId) => service.installFromCatalog(sourceId, itemId));
        ctx.handle('inspect-url', (event, url) => service.inspectUrl(url));
        ctx.handle('install-inspected', (event, token, id) => service.installInspected(token, id));
        ctx.handle('cancel-inspected', (event, token) => service.cancelInspected(token));
    }
};
