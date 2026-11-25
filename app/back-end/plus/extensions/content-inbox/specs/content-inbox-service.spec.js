const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createPubliiData } = require('../../ai-assistant/agent/publii-data');
const inbox = require('../index');
const { createPublisher } = require('../publisher');

const schema = fs.readFileSync(path.join(__dirname, '../../../../sql/1.0.0.sql'), 'utf8');

function setup ({ publishImpl } = {}) {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-app-'));
    const sitesDir = path.join(appDir, 'sites');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-dir-'));
    const siteConfig = { name: 'blog', theme: 'simple', advanced: { urls: {} } };
    fs.mkdirSync(path.join(sitesDir, 'blog', 'input', 'config'), { recursive: true });
    fs.writeFileSync(path.join(sitesDir, 'blog', 'input', 'config', 'site.config.json'), JSON.stringify(siteConfig));
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    db.prepare("INSERT INTO authors VALUES(null, 'Anna', 'anna', '', '{}', '{}')").run();

    const published = [];
    const notes = [];
    const secretValues = {};
    let clock = 1_000_000;
    const service = inbox.createService({
        appDir,
        data: createPubliiData({ app: { appDir: path.resolve(__dirname, '../../../../..'), sitesDir, sites: { blog: siteConfig }, getDbForSite: () => db } }),
        secrets: { get: async k => secretValues[k] || '', set: async (k, v) => { secretValues[k] = v; }, remove: async k => { delete secretValues[k]; } },
        uploadImage: async () => 'x.png',
        publisher: {
            busy: null,
            canPublish: () => '',
            publish: async site => { published.push(site); if (publishImpl) return publishImpl(); return { ok: true }; }
        },
        sites: () => ['blog'],
        notify: (title, body) => notes.push(body),
        now: () => clock
    });

    return { service, appDir, dir, published, notes, secretValues, db, tick: ms => { clock += ms; }, write: (n, t) => fs.writeFileSync(path.join(dir, n), t) };
}

describe('Publii Plus: content inbox – service', () => {
    it('validates settings and keeps the token in the secret store', async () => {
        const t = setup();
        assert.throws(() => inbox.sanitizeConfig({ repo: 'not a repo!' }), /owner\/name/);
        assert.throws(() => inbox.sanitizeConfig({ folder: '../x' }), /Invalid folder/);
        assert.equal(inbox.sanitizeConfig({ repo: 'https://github.com/me/site.git' }).repo, 'me/site');
        assert.equal(inbox.sanitizeConfig({ intervalMinutes: 1 }).intervalMinutes, 5);

        await t.service.save('blog', { source: 'github', repo: 'me/site' }, 'secret-token');
        assert.equal(t.secretValues['inbox:blog'], 'secret-token');
        assert.equal(await t.service.hasToken('blog'), true);
        assert.doesNotMatch(fs.readFileSync(path.join(t.appDir, 'config', 'publii-plus-inbox.json'), 'utf8'), /secret-token/, 'no token in the settings file');
        await t.service.save('blog', { source: 'github', repo: 'me/site' }, '');
        assert.equal(await t.service.hasToken('blog'), false);
        await assert.rejects(t.service.run('../x'), /Invalid website/);
    });

    it('imports, publishes only when something changed, logs and notifies', async () => {
        const t = setup();
        await t.service.save('blog', { source: 'folder', dir: t.dir, autoSync: true });
        t.write('one.md', '# One\n\nText');

        const dry = await t.service.check('blog');
        assert.deepEqual(dry.items.map(i => i.action), ['create']);

        const first = await t.service.run('blog');
        assert.deepEqual([first.created, first.synced, first.error], [1, true, '']);
        assert.deepEqual(t.published, ['blog']);
        assert.match(t.notes[0], /1 new, website synced/);

        t.tick(60000);
        const again = await t.service.run('blog');
        assert.deepEqual([again.created, again.updated, again.synced], [0, 0, false]);
        assert.equal(t.published.length, 1, 'nothing changed – no sync');

        const status = t.service.status('blog');
        assert.equal(status.imported, 1);
        assert.equal(status.log.length, 2);
        assert.deepEqual(status.log[1].items.map(i => [i.path, i.action]), [['one.md', 'create']]);
    });

    it('sync errors are logged; publish can be switched off per run; missing source is an error entry', async () => {
        const t = setup({ publishImpl: () => { throw new Error('Cannot sync automatically: no server is configured.'); } });
        await t.service.save('blog', { source: 'folder', dir: t.dir, autoSync: true });
        t.write('a.md', '# A');
        const out = await t.service.run('blog');
        assert.equal(out.created, 1);
        assert.match(out.syncError, /no server/);

        t.write('b.md', '# B');
        t.tick(1000);
        const noPublish = await t.service.run('blog', { publish: false });
        assert.equal(noPublish.created, 1);
        assert.equal(t.published.length, 1);

        await t.service.save('blog', { source: 'github', repo: '' });
        const broken = await t.service.run('blog');
        assert.match(broken.error, /Set the GitHub repository/);
    });

    it('scheduler runs enabled websites when they are due', async () => {
        const t = setup();
        await t.service.save('blog', { source: 'folder', dir: t.dir, enabled: false, intervalMinutes: 10 });
        t.write('a.md', '# A');
        await t.service.tick();
        assert.equal(t.service.status('blog').log.length, 0, 'disabled');

        await t.service.save('blog', { source: 'folder', dir: t.dir, enabled: true, intervalMinutes: 10 });
        await t.service.tick();
        assert.equal(t.service.status('blog').log.length, 1);
        assert.equal(t.service.status('blog').log[0].trigger, 'schedule');

        t.tick(5 * 60000);
        await t.service.tick();
        assert.equal(t.service.status('blog').log.length, 1, 'not due yet');
        t.tick(6 * 60000);
        await t.service.tick();
        assert.equal(t.service.status('blog').log.length, 2);
    });
});

describe('Publii Plus: content inbox – publisher', () => {
    function fakeWorkers (script) {
        const sent = [];
        return {
            sent,
            forkWorker: (file) => {
                const child = new EventEmitter();
                child.kill = () => {};
                child.send = msg => {
                    sent.push([file, msg.type]);
                    setImmediate(() => (script[file] || []).forEach(m => child.emit('message', m)));
                };
                return child;
            }
        };
    }

    const app = { appDir: '/app', sitesDir: '/sites', appConfig: {}, sites: { blog: { name: 'blog', deployment: { protocol: 'github-pages' } } } };

    it('renders, syncs and saves the sync status', async () => {
        const saved = [];
        const w = fakeWorkers({
            [path.join('renderer', 'preview')]: [{ type: 'app-rendering-progress', progress: 50 }, { type: 'app-rendering-results', result: true }],
            [path.join('deploy', 'deployment')]: [{ type: 'web-contents', message: 'app-uploading-progress', value: {} }, { type: 'web-contents', message: 'app-deploy-uploaded', value: { status: true } }]
        });
        const p = createPublisher({ app, forkWorker: w.forkWorker, saveSyncStatus: s => saved.push(s) });
        assert.deepEqual(await p.publish('blog'), { ok: true, issues: false });
        assert.deepEqual(w.sent.map(s => s[0]), [path.join('renderer', 'preview'), path.join('deploy', 'deployment')]);
        assert.deepEqual(saved, ['blog']);
    });

    it('refuses what needs the user and reports worker errors', async () => {
        const none = createPublisher({ app: { ...app, sites: { blog: { deployment: { protocol: '' } } } }, forkWorker: () => { throw new Error('no'); } });
        await assert.rejects(none.publish('blog'), /no server is configured/);
        assert.equal(createPublisher({ app: { ...app, sites: { blog: { deployment: { protocol: 'manual' } } } }, forkWorker: () => {} }).canPublish('blog'), '', 'manual deployment writes the folder/archive');
        const ask = createPublisher({ app: { ...app, sites: { blog: { deployment: { protocol: 'sftp', askforpassword: true } } } }, forkWorker: () => { throw new Error('no'); } });
        await assert.rejects(ask.publish('blog'), /asks for the password/);

        const renderFail = createPublisher({ app, forkWorker: fakeWorkers({ [path.join('renderer', 'preview')]: [{ type: 'app-rendering-results', result: [{ message: 'Theme error', desc: 'x' }] }] }).forkWorker });
        await assert.rejects(renderFail.publish('blog'), /Render: rendering failed: Theme error/);

        const empty = createPublisher({
            app,
            forkWorker: fakeWorkers({
                [path.join('renderer', 'preview')]: [{ type: 'app-rendering-results', result: true }],
                [path.join('deploy', 'deployment')]: [{ type: 'web-contents', message: 'no-remote-files' }]
            }).forkWorker
        });
        await assert.rejects(empty.publish('blog'), /do the first sync in Publii/);

        const conn = createPublisher({
            app,
            forkWorker: fakeWorkers({
                [path.join('renderer', 'preview')]: [{ type: 'app-rendering-results', result: true }],
                [path.join('deploy', 'deployment')]: [{ type: 'web-contents', message: 'app-connection-error', value: { additionalMessage: { translation: 'core.server.requestTimeout' } } }]
            }).forkWorker
        });
        await assert.rejects(conn.publish('blog'), /Sync: connection error: core\.server\.requestTimeout/);
    });
});
