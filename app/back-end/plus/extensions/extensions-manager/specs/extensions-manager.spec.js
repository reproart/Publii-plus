const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fflate = require('fflate');
const ZipHelper = require('../../../../helpers/zip.helper.js');
const ext = require('../index');

const enc = s => new TextEncoder().encode(s);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function pluginZip (folder, { version = '1.0.0', minimum = '0.46.0', withMain = true } = {}) {
    const files = {
        [`${folder}/plugin.json`]: enc(JSON.stringify({ name: 'Demo ' + folder, version, author: 'me', scope: 'site', minimumPubliiVersion: minimum, description: 'demo' })),
        [`${folder}/LICENSE`]: enc('GPL')
    };

    if (withMain) files[`${folder}/main.js`] = enc('module.exports = class {};');

    return Buffer.from(fflate.zipSync(files));
}

function themeZip (folder, version = '2.0.0') {
    return Buffer.from(fflate.zipSync({
        [`${folder}/config.json`]: enc(JSON.stringify({ name: 'My Theme', version, author: 'me' })),
        [`${folder}/index.hbs`]: enc('{{title}}'),
        [`${folder}/post.hbs`]: enc('{{title}}')
    }));
}

/** Fake api.github.com: releases/tags/catalog, release assets, repository zipball. */
function startGitHub ({ files, requireToken = null }) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept });

        if (requireToken && req.headers.authorization !== 'Bearer ' + requireToken) {
            res.writeHead(404);
            return res.end('{"message":"Not Found"}');
        }

        const base = `http://127.0.0.1:${server.address().port}`;

        if (req.url === '/repos/me/exts/releases/tags/catalog') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ assets: Object.keys(files).map((name, i) => ({ name, url: `${base}/assets/${i}` })) }));
        }

        const m = req.url.match(/^\/assets\/(\d+)$/);

        if (m) {
            const body = Object.values(files)[Number(m[1])];
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
            return res.end(body);
        }

        if (req.url === '/someone/publii-mermaid-support-plugin/archive/HEAD.zip') {
            const zip = pluginZip('publii-mermaid-support-plugin-main');
            res.writeHead(200, { 'Content-Type': 'application/zip' });
            return res.end(zip);
        }

        res.writeHead(404);
        res.end('{}');
    });

    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        server, requests, apiBase: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r))
    })));
}

function makeService ({ apiBase, tokens = {}, blocking = [], sources = null }) {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-ext-app-'));
    const reloads = [];

    if (sources) {
        fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(appDir, 'config', 'publii-plus-extensions.json'), JSON.stringify({ sources }));
    }

    const store = { ...tokens };
    const service = ext.createService({
        appDir,
        appVersion: '0.48.3',
        apiBase,
        githubBase: apiBase,
        extractZip: (zip, target) => ZipHelper.extractZipSafely(zip, target),
        secrets: { get: async id => store[id] || '', set: async (id, v) => { store[id] = v; }, remove: async id => { delete store[id]; } },
        reloadLists: type => reloads.push(type),
        blockingSites: id => (blocking.includes(id) ? ['blog'] : [])
    });

    return { service, appDir, reloads, store };
}

const SOURCE = [{ id: 'mine', name: 'Mine', type: 'github', owner: 'me', repo: 'exts', tag: 'catalog' }];

function catalogFiles (items, zips) {
    return {
        'catalog.json': Buffer.from(JSON.stringify({ format: 'publii-plus-catalog', version: 1, items })),
        ...zips
    };
}

describe('Publii Plus: extensions manager', () => {
    it('compares versions and suggests install names', () => {
        assert.equal(ext.compareVersions('1.10.0', '1.9.2'), 1);
        assert.equal(ext.compareVersions('1.0', '1.0.0'), 0);
        assert.equal(ext.compareVersions('0.46.0', '0.48.3'), -1);
        assert.equal(ext.idFromRepoName('publii-mermaid-support-plugin'), 'mermaidSupport');
        assert.equal(ext.idFromRepoName('my_cool-theme'), 'myCool');
        assert.equal(ext.DEFAULT_SOURCES[0].repo, 'publii_modified');
    });

    it('reads the catalog of a GitHub release and reports install status', async () => {
        const zipA = pluginZip('alpha', { version: '1.2.0' });
        const zipT = themeZip('mytheme');
        const gh = await startGitHub({ files: catalogFiles([
            { id: 'alpha', type: 'plugin', name: 'Alpha', version: '1.2.0', file: 'alpha_1.2.0.zip', size: zipA.length, sha256: sha(zipA) },
            { id: 'mytheme', type: 'theme', name: 'My Theme', version: '2.0.0', file: 'mytheme_2.0.0.zip', size: zipT.length, sha256: sha(zipT) },
            { id: '../evil', type: 'plugin', name: 'x', version: '1', file: 'x.zip' }
        ], { 'alpha_1.2.0.zip': zipA, 'mytheme_2.0.0.zip': zipT }) });

        try {
            const { service, appDir } = makeService({ apiBase: gh.apiBase, sources: SOURCE });
            fs.mkdirSync(path.join(appDir, 'plugins', 'alpha'), { recursive: true });
            fs.writeFileSync(path.join(appDir, 'plugins', 'alpha', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));

            const [result] = await service.catalog();
            assert.equal(result.error, undefined);
            assert.deepEqual(result.items.map(i => [i.id, i.status, i.installed]), [['alpha', 'update', '1.0.0'], ['mytheme', 'available', null]]);
        } finally {
            await gh.close();
        }
    });

    it('installs and updates from the catalog, verifying the checksum', async () => {
        const zipA = pluginZip('alpha', { version: '1.2.0' });
        const zipT = themeZip('mytheme');
        const items = [
            { id: 'alpha', type: 'plugin', name: 'Alpha', version: '1.2.0', file: 'alpha_1.2.0.zip', size: zipA.length, sha256: sha(zipA) },
            { id: 'mytheme', type: 'theme', name: 'My Theme', version: '2.0.0', file: 'mytheme_2.0.0.zip', size: zipT.length, sha256: sha(zipT) },
            { id: 'tampered', type: 'plugin', name: 'T', version: '1.0.0', file: 'tampered.zip', size: zipA.length, sha256: '0'.repeat(64) }
        ];
        const gh = await startGitHub({ files: catalogFiles(items, { 'alpha_1.2.0.zip': zipA, 'mytheme_2.0.0.zip': zipT, 'tampered.zip': zipA }) });

        try {
            const { service, appDir, reloads } = makeService({ apiBase: gh.apiBase, sources: SOURCE });
            fs.mkdirSync(path.join(appDir, 'plugins', 'alpha'), { recursive: true });
            fs.writeFileSync(path.join(appDir, 'plugins', 'alpha', 'old-file.txt'), 'old');

            const up = await service.installFromCatalog('mine', 'alpha');
            assert.deepEqual([up.status, up.version], ['updated', '1.2.0']);
            assert.ok(fs.existsSync(path.join(appDir, 'plugins', 'alpha', 'main.js')));
            assert.ok(!fs.existsSync(path.join(appDir, 'plugins', 'alpha', 'old-file.txt')), 'old files are replaced');

            const theme = await service.installFromCatalog('mine', 'mytheme');
            assert.equal(theme.status, 'added');
            assert.ok(fs.existsSync(path.join(appDir, 'themes', 'mytheme', 'index.hbs')));
            assert.deepEqual(reloads, ['plugin', 'theme']);

            await assert.rejects(service.installFromCatalog('mine', 'tampered'), /Checksum mismatch/);
            assert.ok(!fs.existsSync(path.join(appDir, 'plugins', 'tampered')));
            assert.equal(fs.readdirSync(path.join(appDir, 'plugins')).some(n => n.startsWith('__PLUS_STAGING__')), false);
        } finally {
            await gh.close();
        }
    });

    it('uses the access token for private repositories', async () => {
        const zipA = pluginZip('alpha');
        const gh = await startGitHub({ requireToken: 'ghp_secret', files: catalogFiles([{ id: 'alpha', type: 'plugin', name: 'A', version: '1.0.0', file: 'a.zip' }], { 'a.zip': zipA }) });

        try {
            const noToken = makeService({ apiBase: gh.apiBase, sources: SOURCE });
            const [failed] = await noToken.service.catalog();
            assert.match(failed.error, /HTTP 404.*private and needs a token/);

            const withToken = makeService({ apiBase: gh.apiBase, sources: SOURCE, tokens: { mine: 'ghp_secret' } });
            const [ok] = await withToken.service.catalog();
            assert.equal(ok.items.length, 1);
            assert.ok(gh.requests.some(r => r.accept === 'application/octet-stream' && r.auth === 'Bearer ghp_secret'));
        } finally {
            await gh.close();
        }
    });

    it('installs from a GitHub repository link with a suggested name', async () => {
        const gh = await startGitHub({ files: {} });

        try {
            const { service, appDir } = makeService({ apiBase: gh.apiBase });
            const info = await service.inspectUrl('https://github.com/someone/publii-mermaid-support-plugin');

            assert.equal(info.type, 'plugin');
            assert.equal(info.suggestedId, 'mermaidSupport');
            assert.deepEqual(info.errors, []);

            await assert.rejects(service.installInspected(info.token, '../bad'), /Invalid install name/);

            const again = await service.inspectUrl('https://github.com/someone/publii-mermaid-support-plugin');
            const done = await service.installInspected(again.token, 'mermaidSupport');
            assert.equal(done.status, 'added');
            assert.ok(fs.existsSync(path.join(appDir, 'plugins', 'mermaidSupport', 'plugin.json')));
            await assert.rejects(service.installInspected(again.token, 'x'), /Inspect the link again/);
        } finally {
            await gh.close();
        }
    });

    it('rejects broken or incompatible extensions and plugins with open settings', async () => {
        const broken = pluginZip('broken', { withMain: false });
        const future = pluginZip('future', { minimum: '9.0.0' });
        const notExt = Buffer.from(fflate.zipSync({ 'readme/README.md': enc('hi') }));
        const files = catalogFiles([
            { id: 'broken', type: 'plugin', name: 'B', version: '1.0.0', file: 'broken.zip' },
            { id: 'future', type: 'plugin', name: 'F', version: '1.0.0', file: 'future.zip' },
            { id: 'alpha', type: 'plugin', name: 'A', version: '1.0.0', file: 'alpha.zip' },
            { id: 'wrongtype', type: 'theme', name: 'W', version: '1.0.0', file: 'alpha.zip' }
        ], { 'broken.zip': broken, 'future.zip': future, 'alpha.zip': pluginZip('alpha'), 'notext.zip': notExt });
        const gh = await startGitHub({ files });

        try {
            const { service, appDir } = makeService({ apiBase: gh.apiBase, sources: SOURCE, blocking: ['alpha'] });

            await assert.rejects(service.installFromCatalog('mine', 'broken'), /main\.js is missing/);
            await assert.rejects(service.installFromCatalog('mine', 'future'), /Requires Publii 9\.0\.0 or newer/);
            await assert.rejects(service.installFromCatalog('mine', 'alpha'), /Close the settings of this plugin first \(open in: blog\)/);
            await assert.rejects(service.installFromCatalog('mine', 'wrongtype'), /contains a plugin, the catalog says theme/);
            assert.deepEqual(fs.existsSync(path.join(appDir, 'plugins')) ? fs.readdirSync(path.join(appDir, 'plugins')) : [], []);

            await assert.rejects(service.inspectUrl(gh.apiBase.replace('127.0.0.1', '127.0.0.1') + '/assets/' + Object.keys(files).indexOf('notext.zip')), /must contain one plugin or theme folder/);
            await assert.rejects(service.inspectUrl('file:///etc/passwd'), /http\(s\) link/);
        } finally {
            await gh.close();
        }
    });

    it('manages sources and keeps tokens out of the config file', async () => {
        const { service, appDir, store } = makeService({ apiBase: 'http://unused' });

        assert.equal((await service.sources())[0].id, 'publii-modified', 'default source');

        const saved = await service.saveSource({ type: 'github', owner: 'acme', repo: 'themes', token: 'ghp_x' });
        assert.equal(saved.name, 'acme/themes');
        assert.equal(store[saved.id], 'ghp_x');
        assert.doesNotMatch(fs.readFileSync(path.join(appDir, 'config', 'publii-plus-extensions.json'), 'utf8'), /ghp_x/);

        const list = await service.sources();
        assert.deepEqual(list.map(s => [s.id, s.hasToken]), [['publii-modified', false], [saved.id, true]]);

        await assert.rejects(service.saveSource({ type: 'url', url: 'ftp://x/catalog.json' }), /valid catalog\.json URL/);
        await assert.rejects(service.saveSource({ type: 'github', owner: 'a b', repo: 'x' }), /owner and repository/);

        await service.removeSource(saved.id);
        assert.equal(store[saved.id], undefined);
    });
});
