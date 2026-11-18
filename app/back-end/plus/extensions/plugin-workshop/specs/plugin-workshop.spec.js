const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fflate = require('fflate');
const workshop = require('../index');
const hookLogger = require('../../../hook-logger');
const RendererPlugins = require('../../../../modules/render-html/renderer-plugins.js');

function makeApp () {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-ws-'));
    const plugin = path.join(appDir, 'plugins', 'externalLinks');

    fs.mkdirSync(path.join(plugin, 'front-assets'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ name: 'External Links', version: '2.3.0', author: 'T', scope: 'site', minimumPubliiVersion: '0.46.0', description: 'd', config: [{ name: 'icon', type: 'text', value: 'x' }] }, null, 2) + '\n');
    fs.writeFileSync(path.join(plugin, 'main.js'), [
        'class P {',
        '  constructor (API, name, config) { this.API = API; this.config = config; }',
        "  addModifiers () { this.API.addModifier('postText', (r, t) => t, 1, this); }",
        '}',
        'module.exports = P;',
        ''
    ].join('\n'));
    fs.writeFileSync(path.join(plugin, 'front-assets', 'style.css'), 'a { color: red; }\n');

    const saved = [];
    const reloads = [];
    const service = workshop.createService({
        appDir,
        appVersion: '0.48.3',
        zipSync: entries => fflate.zipSync(entries),
        runCheck: dir => workshop.runCheckInChild(dir, 3000),
        reloadLists: () => reloads.push(1),
        blockingSites: id => (id === 'locked' ? ['blog'] : []),
        showSaveDialog: async opts => {
            const file = path.join(appDir, 'export-' + opts.defaultPath);
            saved.push(file);
            return { filePath: file };
        },
        env: {}
    });

    return { appDir, service, saved, reloads };
}

describe('Publii Plus: hook log', () => {
    it('measures plugin callbacks, counts changed values and errors, keeps remove() working', () => {
        class Plugins extends RendererPlugins {}
        const { recorder } = hookLogger.install(Plugins, { file: null, onExit: false });
        const api = new Plugins('/sites/blog');
        const pluginA = { name: 'alpha' };
        const upper = (r, text) => text.toUpperCase();
        const same = (r, text) => text;

        api.addModifier('postText', upper, 1, pluginA);
        api.addModifier('postText', same, 2, { name: 'beta' });
        api.addInsertion('customHeadCode', function () { return 'x:' + this.name; }, 1, pluginA);
        api.addEvent('afterRender', () => { throw new Error('boom'); }, 1, pluginA);

        assert.equal(api.runModifiers('postText', {}, 'abc'), 'ABC');
        assert.equal(api.runModifiers('postText', {}, 'def'), 'DEF');
        assert.equal(api.runInsertions('customHeadCode', {}), 'x:alpha', 'this = plugin instance');
        assert.throws(() => api.runEvents('afterRender', {}), /boom/);

        const rows = recorder.list().map(e => [e.plugin, e.type, e.hook, e.calls, e.changed, e.errors]);
        assert.deepEqual(rows, [
            ['alpha', 'events', 'afterRender', 1, 0, 1],
            ['alpha', 'insertions', 'customHeadCode', 1, 0, 0],
            ['alpha', 'modifiers', 'postText', 2, 2, 0],
            ['beta', 'modifiers', 'postText', 2, 0, 0]
        ]);

        api.removeModifier('postText', upper, 1);
        assert.equal(api.runModifiers('postText', {}, 'x'), 'x', 'removal by the original callback still works');
        assert.equal(RendererPlugins.prototype.__publiiPlusHookLog, undefined, 'the base class stays untouched');
    });
});

describe('Publii Plus: plugin workshop', () => {
    it('copies a plugin with a base snapshot and tracks changes', () => {
        const { appDir, service, reloads } = makeApp();

        assert.throws(() => service.copy('externalLinks', 'externalLinks'), /already exists/);
        assert.throws(() => service.copy('externalLinks', '1bad'), /start with a letter/);

        service.copy('externalLinks', 'externalLinksMy');
        const json = JSON.parse(fs.readFileSync(path.join(appDir, 'plugins', 'externalLinksMy', 'plugin.json'), 'utf8'));
        assert.equal(json.name, 'External Links (my copy)');
        assert.equal(reloads.length, 1);

        const list = service.list().plugins.map(p => [p.id, p.workshop, p.origin ? p.origin.version : undefined]);
        assert.deepEqual(list, [['externalLinks', false, undefined], ['externalLinksMy', true, '2.3.0']]);

        assert.deepEqual(service.files('externalLinksMy').files.map(f => [f.path, f.changed]),
            [['front-assets/style.css', false], ['main.js', false], ['plugin.json', false]], 'renaming alone is not a change');

        assert.throws(() => service.files('externalLinks'), /make a copy first/);
    });

    it('saves with validation and exports a diff that ignores the renamed title', async () => {
        const { service, saved } = makeApp();
        service.copy('externalLinks', 'mine');

        const bad = service.save('mine', 'main.js', 'class {');
        assert.equal(bad.ok, false);

        service.save('mine', 'front-assets/style.css', 'a { color: blue; }\n');
        service.createFile('mine', 'front-assets/extra.css');
        service.save('mine', 'front-assets/extra.css', '.x {}\n');

        const files = Object.fromEntries(service.files('mine').files.map(f => [f.path, [f.changed, f.added]]));
        assert.deepEqual(files['front-assets/style.css'], [true, false]);
        assert.deepEqual(files['front-assets/extra.css'], [true, true]);

        const diff = service.diff('mine');
        assert.match(diff, /--- a\/front-assets\/style\.css\n\+\+\+ b\/front-assets\/style\.css\n@@ -1,1 \+1,1 @@\n-a \{ color: red; \}\n\+a \{ color: blue; \}/);
        assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/front-assets\/extra\.css/);
        assert.doesNotMatch(diff, /plugin\.json/, 'the "(my copy)" title is not part of the diff');

        const out = await service.exportDiff('mine');
        assert.equal(out.files, 2);
        assert.match(path.basename(saved[0]), /externalLinks-2\.3\.0-changes\.diff$/);
        assert.equal(fs.readFileSync(saved[0], 'utf8'), diff);

        const zip = await service.exportZip('mine');
        const entries = Object.keys(fflate.unzipSync(new Uint8Array(fs.readFileSync(zip.filePath))));
        assert.deepEqual(entries.sort(), ['mine/front-assets/extra.css', 'mine/front-assets/style.css', 'mine/main.js', 'mine/plugin.json']);

        assert.throws(() => service.deleteFile('mine', 'main.js'), /required/);
        assert.throws(() => service.read('mine', '../externalLinks/main.js'), /Invalid file path/);
    });

    it('checks plugins in a separate process: hooks, typos, crashes and hangs', async function () {
        this.timeout(30000);
        const { service } = makeApp();
        service.create('fresh', 'Fresh plugin');

        const ok = await service.check('fresh');
        assert.equal(ok.ok, true, JSON.stringify(ok));
        assert.deepEqual(ok.hooks, { insertions: ['customHeadCode'], modifiers: ['postText'], events: [] });
        assert.deepEqual(ok.warnings.filter(w => /Unknown/.test(w)), []);

        service.save('fresh', 'main.js', "class P { constructor (A) { this.A = A; } addModifiers () { this.A.addModifier('postContent', (r, t) => t, 1, this); } }\nmodule.exports = P;\n");
        const typo = await service.check('fresh');
        assert.match(typo.warnings.join(' '), /Unknown modifier "postContent"/);

        service.save('fresh', 'main.js', 'throw new Error("kaput");\n');
        const crash = await service.check('fresh');
        assert.equal(crash.ok, false);
        assert.match(crash.errors.join(' '), /main\.js failed to load: .*kaput/);

        service.save('fresh', 'main.js', 'while (true) {}\n');

        const started = Date.now();
        const slow = await service.check('fresh');
        assert.equal(slow.ok, false);
        assert.match(slow.errors.join(' '), /did not finish loading within 3 s/);
        assert.ok(Date.now() - started < 15000);
    });

    it('removes workshop plugins unless their settings are open; hook log switch', () => {
        const { appDir, service } = makeApp();
        service.create('locked', 'Locked');
        assert.throws(() => service.remove('locked'), /Close the settings/);

        service.create('gone', 'Gone');
        service.remove('gone');
        assert.equal(fs.existsSync(path.join(appDir, 'plugins', 'gone')), false);
        assert.throws(() => service.remove('externalLinks'), /make a copy first/, 'installed plugins are not deleted here');

        assert.equal(service.hookLogState().enabled, false);
        assert.equal(service.setHookLog(true).enabled, true);
        assert.equal(service.setHookLog(false).enabled, false);
    });
});
