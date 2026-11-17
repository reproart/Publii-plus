const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadExtensions, discoverExtensions, channelName } = require('../extension-loader');

function fakeIpc () {
    const handlers = {};
    return { handlers, handle (channel, fn) { handlers[channel] = fn; } };
}

function makeExtensions (files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-ext-'));

    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }

    return dir;
}

const silent = { log () {}, error () {} };

describe('Publii Plus extension loader', () => {
    it('builds prefixed channel names and rejects unsafe ones', () => {
        assert.equal(channelName('ai-assistant', 'generate'), 'plus:ai-assistant:generate');
        assert.throws(() => channelName('../x', 'a'));
        assert.throws(() => channelName('ok', 'a b'));
    });

    it('discovers only directories with a valid id and an index.js', () => {
        const dir = makeExtensions({
            'good/index.js': 'module.exports = {}',
            'Bad_Name/index.js': 'module.exports = {}',
            'no-index/readme.md': '',
            '_hidden/index.js': ''
        });

        assert.deepEqual(discoverExtensions(dir), ['good']);
    });

    it('registers handlers and isolates failing extensions', async () => {
        const dir = makeExtensions({
            'alpha/index.js': "module.exports = { id: 'alpha', name: 'Alpha', register (ctx) { ctx.handle('ping', async (e, x) => 'pong ' + x + ' ' + ctx.paths.appDir); } };",
            'broken/index.js': "throw new Error('boom');",
            'wrong-id/index.js': "module.exports = { id: 'other', register () {} };"
        });
        const ipc = fakeIpc();
        const summary = loadExtensions({ ipcMain: ipc, appInstance: { appDir: '/docs/Publii' }, extensionsDir: dir, logger: silent });

        assert.deepEqual(summary.map(e => [e.id, e.loaded]), [['alpha', true], ['broken', false], ['wrong-id', false]]);
        assert.match(summary[1].error, /boom/);
        assert.match(summary[2].error, /must export/);
        assert.deepEqual(Object.keys(ipc.handlers), ['plus:alpha:ping']);
        assert.equal(await ipc.handlers['plus:alpha:ping']({}, 1), 'pong 1 /docs/Publii');
    });

    it('loads the bundled core extension', async () => {
        const ipc = fakeIpc();
        const summary = loadExtensions({ ipcMain: ipc, appInstance: { appDir: '/x' }, logger: silent });
        assert.ok(summary.find(e => e.id === 'core' && e.loaded));

        const info = await ipc.handlers['plus:core:info']();
        assert.match(info.plusVersion, /^\d+\.\d+\.\d+$/);
        assert.equal(info.upstreamVersion, require('../../../package.json').version);
    });
});
