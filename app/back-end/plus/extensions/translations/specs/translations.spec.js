const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPubliiData } = require('../../ai-assistant/agent/publii-data');
const { segment } = require('../segments');
const { remapLinks, linkedFiles } = require('../links');
const { translatePost, batches } = require('../translate');
const { createEngine } = require('../engine');
const { createService, sanitizeConfig } = require('../index');

const schema = fs.readFileSync(path.join(__dirname, '../../../../sql/1.0.0.sql'), 'utf8');

/** Fake model: "translates" by prefixing every text with the language code; tags become "<lang>-<name>" */
function fakeGenerate (to, log = [], { fail = null, merge = false } = {}) {
    return async (system, user, schema, schemaName) => {
        const json = JSON.parse(user.slice(user.indexOf('\n\n{') + 2));
        log.push({ system, schemaName, json });

        if (fail && fail(json)) throw new Error('Model unavailable');

        if (schemaName === 'translation') {
            const segments = json.segments.map(s => s.replace(/(^|>)([^<>]*\p{L}[^<>]*)(?=<|$)/gu, (all, a, t) => `${a}[${to}] ${t.trim()}`));
            return { data: { segments: merge && segments.length > 1 ? [segments.join(' ')] : segments }, usage: { input: 10, output: 5 } };
        }

        const data = {};

        for (const k of ['title', 'metaTitle', 'metaDescription', 'featuredAlt', 'featuredCaption']) data[k] = json[k] ? `[${to}] ${json[k]}` : '';

        data.tags = json.tags.map(t => `${to}-${t}`);
        return { data, usage: { input: 3, output: 2 } };
    };
}

function setup () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-translations-'));
    const appDir = path.join(root, 'app');
    const sitesDir = path.join(root, 'sites');
    const sites = {
        en: { name: 'en', displayName: 'Clinic', language: 'en', advanced: { urls: {} } },
        ru: { name: 'ru', displayName: 'Клиника', language: 'ru', advanced: { urls: {} } },
        de: { name: 'de', displayName: 'Klinik', language: 'de', advanced: { urls: {} } },
        en2: { name: 'en2', language: 'en', advanced: { urls: {} } }
    };
    const dbMap = new Map();
    let opened = 0;

    for (const site of Object.keys(sites)) {
        fs.mkdirSync(path.join(sitesDir, site, 'input', 'config'), { recursive: true });
        fs.writeFileSync(path.join(sitesDir, site, 'input', 'config', 'site.config.json'), JSON.stringify(sites[site]));

        // "de" is not open in Publii: a database file on disk
        const db = new DatabaseSync(site === 'de' ? path.join(sitesDir, site, 'input', 'db.sqlite') : ':memory:');
        db.exec(schema);
        db.prepare("INSERT INTO authors VALUES(null, 'Anna', 'anna', '', '{}', '{}')").run();

        if (site === 'de') db.close();
        else dbMap.set(site, db);
    }

    const app = {
        appDir,
        sitesDir,
        sites,
        getDbForSite: s => dbMap.get(s) || false,
        setDbForSite: (s, db) => { dbMap.set(s, db); },
        closeDbForSite: s => { if (dbMap.has(s)) { dbMap.get(s).close(); dbMap.delete(s); } }
    };
    const data = createPubliiData({ app });
    let clock = Date.parse('2026-11-01T10:00:00Z');
    const now = () => clock;
    const engine = createEngine({ app, data, openDb: file => { opened++; return new DatabaseSync(file); }, now });
    const calls = [];
    let options = {};
    const service = createService({
        appDir,
        engine,
        sites: () => sites,
        makeGenerate: async (providerId, target) => fakeGenerate(target, calls, options),
        now
    });
    const db = site => app.getDbForSite(site);

    const post = (site, fields) => {
        const out = data.createPost(site, { editor: 'markdown', status: 'published', ...fields });

        if (fields.image) {
            fs.mkdirSync(data.mediaDir(site, out.id), { recursive: true });
            fs.writeFileSync(path.join(data.mediaDir(site, out.id), fields.image), 'IMG');
            data.setFeaturedImage(site, out.id, { filename: fields.image, alt: 'Doctor at work', caption: 'Photo', credits: 'Anna' });
        }

        return out.id;
    };

    const openDe = fn => engine.withSite('de', fn);

    return {
        app, data, engine, service, db, post, sitesDir, calls, openDe,
        setOptions: o => { options = o; },
        tick: ms => { clock += ms; },
        opened: () => opened
    };
}

describe('Publii Plus: translations – pieces of the text', () => {
    it('keeps code, markup and block settings, translates only text', () => {
        const md = '# Title\n\nFirst line\nsecond line\n\n```js\nconst a = 1; // comment\n```\n\n![Alt](#DOMAIN_NAME#a.png)\n\n- one\n- two\n';
        const m = segment(md, 'markdown');
        assert.equal(m.pieces.some(p => p.includes('const a')), false, 'fenced code is not sent');
        assert.equal(m.rebuild(m.pieces), md);
        assert.equal(m.rebuild(m.pieces.map(p => p.toUpperCase())), md.replace('# Title\n\nFirst line\nsecond line', '# TITLE\n\nFIRST LINE\nSECOND LINE').replace('![Alt](#DOMAIN_NAME#a.png)\n\n- one\n- two', '![ALT](#DOMAIN_NAME#A.PNG)\n\n- ONE\n- TWO'));

        const html = '<h2>Head</h2>\n<p>Para <b>bold</b></p>\n<pre><code>let x = <b>1</b>;</code></pre>\n<p>&nbsp;</p>\n<figure><img src="#DOMAIN_NAME#a.png" alt="Cat"><figcaption>Cap</figcaption></figure>';
        const h = segment(html, 'tinymce');
        assert.deepEqual(h.pieces, ['<h2>Head</h2>\n<p>Para <b>bold</b></p>', '<figure><img src="#DOMAIN_NAME#a.png" alt="Cat"><figcaption>Cap</figcaption></figure>']);
        assert.equal(h.rebuild(h.pieces), html);

        const blocks = [
            { id: 1, type: 'publii-paragraph', content: 'Hello <b>world</b>', config: { advanced: { id: 'intro' } } },
            { id: 2, type: 'publii-code', content: 'code text', config: {} },
            { id: 3, type: 'publii-image', content: { image: '#DOMAIN_NAME#a.png', alt: 'A cat', caption: 'Cap', imageWidth: 10 }, config: {} },
            { id: 4, type: 'publii-table', content: { headers: ['Name', '1'], rows: [['Row one', '2']] }, config: {} },
            { id: 5, type: 'publii-quote', content: { text: 'Quote', author: 'Anna' }, config: {} },
            { id: 6, type: 'publii-separator', content: '', config: {} }
        ];
        const b = segment(JSON.stringify(blocks), 'blockeditor');
        assert.deepEqual(b.pieces, ['Hello <b>world</b>', 'Cap', 'A cat', 'Name', 'Row one', 'Quote', 'Anna']);
        const back = JSON.parse(b.rebuild(b.pieces.map(p => p + ' "x"')));
        assert.equal(back[0].content, 'Hello <b>world</b> "x"');
        assert.equal(back[2].content.alt, "A cat 'x'", 'no double quotes in alt texts');
        assert.deepEqual(back[0].config, blocks[0].config);
        assert.equal(back[1].content, 'code text');
        assert.deepEqual(back[3].content.headers, ['Name "x"', '1']);
        assert.equal(segment('not json', 'blockeditor').rebuild([]), 'not json');
    });

    it('maps internal links and finds linked files', () => {
        const text = '<a href="#INTERNAL_LINK#/post/3">A</a> <a href="#INTERNAL_LINK#/tag/2">T</a> <a href="#INTERNAL_LINK#/page/9">P</a> <a href="#INTERNAL_LINK#/file/media/files/My%20guide.pdf">F</a>';
        const first = remapLinks(text, (type, id) => (type === 'post' && id === 3 ? 30 : type === 'tag' ? 20 : null));
        assert.equal(first.unresolved, 1);
        assert.match(first.text, /post\/30".*tag\/20".*page\/plus-src-9"/);
        const later = remapLinks(first.text.replace('post/30', 'post/31'), (type, id) => (type === 'page' && id === 9 ? 90 : 1), { pendingOnly: true });
        assert.equal(later.unresolved, 0);
        assert.match(later.text, /post\/31".*tag\/20".*page\/90"/, 'only marked links change');
        assert.deepEqual(linkedFiles(text + ' #INTERNAL_LINK#/file/media/files/../../db.sqlite'), ['media/files/My guide.pdf']);
    });

    it('translates in batches and falls back to single pieces when the model merges them', async () => {
        assert.deepEqual(batches(['a'.repeat(3000), 'b'.repeat(3000), 'c']), [[0], [1, 2]]);

        const log = [];
        const post = { title: 'Heart', text: 'One\n\nTwo\n\n```\ncode\n```\n\nThree', editor: 'markdown', metaTitle: '', metaDescription: 'About the heart', featured: { alt: 'Doctor', caption: '' } };
        const out = await translatePost({ post, newTags: ['Cardiology'], from: 'en', to: 'ru', glossary: 'heart = сердце', generate: fakeGenerate('ru', log, { merge: true }) });

        // "One" and "Two" are one piece (short paragraphs are joined), the code block is not sent
        assert.equal(out.text, '[ru] One\n\nTwo\n\n```\ncode\n```\n\n[ru] Three', 'merged reply → pieces translated one by one');
        assert.equal(log.filter(l => l.schemaName === 'translation').length, 3, 'one batch + two single pieces');
        assert.equal(out.title, '[ru] Heart');
        assert.equal(out.metaTitle, '', 'empty fields stay empty');
        assert.equal(out.featuredAlt, '[ru] Doctor');
        assert.deepEqual(out.tags, { Cardiology: 'ru-Cardiology' });
        assert.match(log[0].system, /from English \(en\) to Russian \(ru\)/);
        assert.match(log[0].system, /heart = сердце/);
        assert.ok(out.usage.input > 0);
    });
});

describe('Publii Plus: translations – mirroring posts into language websites', () => {
    it('validates the settings', () => {
        const t = setup();
        const sites = t.app.sites;

        assert.throws(() => sanitizeConfig({ targets: [{ site: 'en' }] }, { source: 'en', sites }), /own translation/);
        assert.throws(() => sanitizeConfig({ targets: [{ site: 'xx' }] }, { source: 'en', sites }), /does not exist/);
        assert.throws(() => sanitizeConfig({ targets: [{ site: 'en2' }] }, { source: 'en', sites }), /same language/);
        assert.throws(() => sanitizeConfig({ targets: [{ site: 'ru' }] }, { source: 'en', sites, sourcesOf: s => (s === 'ru' ? ['x'] : []) }), /already a translation of "x"/);
        assert.throws(() => sanitizeConfig({ targets: [{ site: 'ru' }] }, { source: 'en', sites, hasTargets: s => s === 'ru' }), /main website/);

        const c = sanitizeConfig({ enabled: 1, intervalMinutes: 1, maxPerRun: 0, targets: [{ site: 'ru', glossary: ' a = b ' }, { site: 'ru' }] }, { source: 'en', sites });
        assert.deepEqual(c, { enabled: true, providerId: '', intervalMinutes: 5, maxPerRun: 10, targets: [{ site: 'ru', glossary: 'a = b' }] });

        t.service.save('en', { targets: [{ site: 'ru' }] });
        assert.throws(() => t.service.save('ru', { targets: [{ site: 'de' }] }), /translation of "en"/);
        assert.throws(() => t.service.save('de', { targets: [{ site: 'en' }] }), /main website of other translations/);
    });

    it('creates translations with the same slug, date, flags, tag slugs, images and mapped links', async () => {
        const t = setup();
        const older = Date.parse('2026-10-01T08:00:00Z');
        const a = t.post('en', { title: 'Heart health', slug: 'cardiology', text: 'Read [the next post](#INTERNAL_LINK#/post/2) and the [guide](#INTERNAL_LINK#/file/media/files/guide.pdf).\n\n![Chart](#DOMAIN_NAME#chart.png)', tags: ['Cardiology'], metaDescription: 'All about the heart', creationDate: older, flags: ['featured'], image: 'cover.jpg' });
        const b = t.post('en', { title: 'Second post', slug: 'second', text: 'Back to [first](#INTERNAL_LINK#/post/1)', tags: ['Cardiology', 'News'], creationDate: older + 1000 });
        t.post('en', { title: 'Work in progress', slug: 'draft-post', text: 'Draft', status: 'draft' });
        t.post('en', { title: 'About us', slug: 'about', text: 'Existing' });
        fs.writeFileSync(path.join(t.data.mediaDir('en', a), 'chart.png'), 'CHART');
        fs.mkdirSync(path.join(t.sitesDir, 'en', 'input', 'media', 'files'), { recursive: true });
        fs.writeFileSync(path.join(t.sitesDir, 'en', 'input', 'media', 'files', 'guide.pdf'), 'PDF');

        // manual translation that already exists in the target website
        const manual = t.post('ru', { title: 'О нас', slug: 'about', text: 'Уже переведено' });
        // images of a new post being edited in the target website must stay where they are
        fs.mkdirSync(path.join(t.sitesDir, 'ru', 'input', 'media', 'posts', 'temp'), { recursive: true });
        fs.writeFileSync(path.join(t.sitesDir, 'ru', 'input', 'media', 'posts', 'temp', 'wip.png'), 'WIP');

        t.service.save('en', { enabled: true, targets: [{ site: 'ru', glossary: 'heart = сердце' }, { site: 'de' }] });

        const before = t.service.status('en');
        assert.deepEqual(before.items.filter(i => i.target === 'ru').map(i => [i.title, i.state]), [
            ['Heart health', 'new'], ['Second post', 'new'], ['Work in progress', 'waiting'], ['About us', 'linked']
        ]);
        assert.equal(before.websites.find(w => w.site === 'ru').languageName, 'Russian (ru)');

        const entry = await t.service.run('en');
        assert.equal(entry.error, '');
        assert.deepEqual([entry.created, entry.linked, entry.errors], [5, 1, 0], '3 posts × 2 websites, "about" linked in ru instead');
        assert.equal(t.opened() > 0, true, 'the closed database of "de" was opened for the writes');
        assert.equal(t.app.getDbForSite('de'), false, '… and closed again');

        const state = JSON.parse(fs.readFileSync(path.join(t.app.appDir, 'config', 'publii-plus-translations', 'en.json'), 'utf8'));
        const ruA = state.posts[a].ru.targetId;
        const ruB = state.posts[b].ru.targetId;
        const ra = t.data.readPost('ru', ruA);

        assert.equal(ra.title, '[ru] Heart health');
        assert.equal(ra.slug, 'cardiology');
        assert.equal(ra.status, 'published');
        assert.deepEqual(ra.flags, ['featured']);
        assert.equal(ra.created, older);
        assert.equal(ra.metaDescription, '[ru] All about the heart');
        assert.deepEqual(ra.tags, ['ru-Cardiology']);
        assert.equal(t.db('ru').prepare("SELECT slug FROM tags WHERE name = 'ru-Cardiology'").get().slug, 'cardiology', 'tag keeps the source slug');
        assert.match(ra.text, new RegExp(`#INTERNAL_LINK#/post/${ruB}\\)`), 'link to the newer post fixed after it was translated');
        assert.match(ra.text, /!\[\[ru\] Chart\]\(#DOMAIN_NAME#chart\.png\)|#DOMAIN_NAME#chart\.png/);
        assert.equal(fs.readFileSync(path.join(t.data.mediaDir('ru', ruA), 'chart.png'), 'utf8'), 'CHART');
        assert.equal(fs.readFileSync(path.join(t.sitesDir, 'ru', 'input', 'media', 'files', 'guide.pdf'), 'utf8'), 'PDF');
        assert.equal(fs.readFileSync(path.join(t.sitesDir, 'ru', 'input', 'media', 'posts', 'temp', 'wip.png'), 'utf8'), 'WIP');

        const img = t.db('ru').prepare('SELECT url, additional_data FROM posts_images WHERE post_id = ?').get(ruA);
        assert.equal(img.url, 'cover.jpg');
        assert.deepEqual(JSON.parse(img.additional_data), { alt: '[ru] Doctor at work', caption: '[ru] Photo', credits: 'Anna' });

        assert.match(t.data.readPost('ru', ruB).text, new RegExp(`#INTERNAL_LINK#/post/${ruA}\\)`));
        assert.equal(state.posts[a].ru.unresolved, 0);
        assert.equal(t.data.readPost('ru', manual).text, 'Уже переведено', 'existing post is not overwritten');
        assert.equal(state.posts[4].ru.manual, true);

        const de = t.openDe(db => db.prepare("SELECT title, slug FROM posts WHERE slug = 'cardiology'").get());
        assert.equal(de.title, '[de] Heart health');

        // tags are translated once per language
        const tagRequests = t.calls.filter(c => c.schemaName === 'translation_fields').map(c => c.json.tags);
        assert.deepEqual(tagRequests.filter(x => x.length), [['Cardiology'], ['News'], ['Cardiology'], ['News']]);

        const again = await t.service.run('en');
        assert.deepEqual([again.created, again.updated, again.meta], [0, 0, 0], 'nothing to do');
        assert.deepEqual([...new Set(t.service.status('en').items.map(i => i.state))].sort(), ['current', 'linked', 'waiting']);
    });

    it('updates changed posts, keeps edited translations, copies status changes, handles deletions', async () => {
        const t = setup();
        const a = t.post('en', { title: 'Heart', slug: 'heart', text: 'Version one' });
        const b = t.post('en', { title: 'Lungs', slug: 'lungs', text: 'Breathing' });
        t.service.save('en', { targets: [{ site: 'ru' }] });
        await t.service.run('en');

        const id = s => JSON.parse(fs.readFileSync(path.join(t.app.appDir, 'config', 'publii-plus-translations', 'en.json'), 'utf8')).posts[s].ru.targetId;
        const ruA = id(a);
        const ruB = id(b);

        // source changed → translated again
        t.tick(60000);
        t.data.updatePost('en', a, { text: 'Version two' });
        assert.equal(t.service.status('en').items.find(i => i.sourceId === a).state, 'outdated');
        let entry = await t.service.run('en');
        assert.equal(entry.updated, 1);
        assert.equal(t.data.readPost('ru', ruA).text, '[ru] Version two');

        // translation edited by hand → not overwritten, but the status is still copied
        t.tick(60000);
        await new Promise(r => setTimeout(r, 1100));
        t.data.updatePost('ru', ruB, { text: 'Исправлено вручную' });
        t.data.updatePost('en', b, { text: 'Breathing exercises', status: 'draft' });
        t.data.updatePost('en', b, { status: 'published', flags: ['hidden'] });
        const item = t.service.status('en').items.find(i => i.sourceId === b);
        assert.deepEqual([item.state, item.action], ['edited', 'meta']);
        entry = await t.service.run('en');
        assert.deepEqual([entry.updated, entry.meta], [0, 1]);
        assert.equal(t.data.readPost('ru', ruB).text, 'Исправлено вручную');
        assert.deepEqual(t.data.readPost('ru', ruB).flags, ['hidden']);
        assert.equal(t.service.status('en').items.find(i => i.sourceId === b).state, 'edited', 'still marked as edited');

        // overwrite on request
        entry = await t.service.overwrite('en', b, 'ru');
        assert.equal(entry.updated, 1);
        assert.equal(t.data.readPost('ru', ruB).text, '[ru] Breathing exercises');
        assert.equal(t.service.status('en').items.find(i => i.sourceId === b).state, 'current');

        // source unpublished → translation becomes a draft; slug change is copied
        t.data.updatePost('en', a, { status: 'draft', slug: 'heart-health' });
        entry = await t.service.run('en');
        assert.deepEqual([entry.meta, entry.updated], [1, 0]);
        assert.deepEqual([t.data.readPost('ru', ruA).status, t.data.readPost('ru', ruA).slug], ['draft', 'heart-health']);

        // translation deleted in the target website → not recreated until "translate again"
        t.data.deletePost('ru', ruB);
        assert.equal(t.service.status('en').items.find(i => i.sourceId === b).state, 'deleted');
        entry = await t.service.run('en');
        assert.equal(entry.created, 0);
        t.service.forget('en', b, 'ru');
        entry = await t.service.run('en');
        assert.equal(entry.created, 1);

        // source post deleted → its translation becomes a draft once
        const ruB2 = id(b);
        t.data.deletePost('en', b);
        entry = await t.service.run('en');
        assert.equal(entry.unpublished, 1);
        assert.equal(t.data.readPost('ru', ruB2).status, 'draft');
        entry = await t.service.run('en');
        assert.equal(entry.unpublished, 0);
    });

    it('translates block editor posts and keeps their structure', async () => {
        const t = setup();
        const blocks = [
            { id: 'a', type: 'publii-header', content: 'Symptoms', config: { headingLevel: 2, link: { url: '' } } },
            { id: 'b', type: 'publii-list', content: '<li>Pain</li><li>Fever</li>', config: { listType: 'ul' } },
            { id: 'c', type: 'publii-code', content: 'npm test', config: {} },
            { id: 'd', type: 'publii-gallery', content: { images: [{ src: '#DOMAIN_NAME#gallery/x.jpg', alt: 'X-ray', caption: '' }] }, config: {} }
        ];
        t.post('en', { title: 'Blocks', slug: 'blocks', text: JSON.stringify(blocks), editor: 'blockeditor' });
        t.service.save('en', { targets: [{ site: 'ru' }] });
        await t.service.run('en');

        const ru = t.db('ru').prepare("SELECT id, text FROM posts WHERE slug = 'blocks'").get();
        const out = JSON.parse(ru.text);
        assert.equal(t.data.readPost('ru', ru.id).editor, 'blockeditor');
        assert.deepEqual(out.map(b => b.id), ['a', 'b', 'c', 'd']);
        assert.equal(out[0].content, '[ru] Symptoms');
        assert.equal(out[1].content, '<li>[ru] Pain</li><li>[ru] Fever</li>');
        assert.equal(out[2].content, 'npm test');
        assert.equal(out[3].content.images[0].alt, '[ru] X-ray');
        assert.deepEqual(out[0].config, blocks[0].config);
    });

    it('limits translations per run, pauses failing posts, runs on schedule', async () => {
        const t = setup();

        for (let i = 1; i <= 3; i++) t.post('en', { title: `Post ${i}`, slug: `post-${i}`, text: `Text ${i}` });

        t.service.save('en', { enabled: true, intervalMinutes: 30, maxPerRun: 2, targets: [{ site: 'ru' }] });

        let entry = await t.service.run('en');
        assert.deepEqual([entry.created, entry.remaining], [2, 1]);

        t.setOptions({ fail: json => JSON.stringify(json).includes('Text 3') });

        for (let i = 0; i < 3; i++) {
            t.tick(31 * 60000);
            entry = await t.service.run('en');
            assert.equal(entry.errors, 1);
        }

        assert.equal(t.service.status('en').items.find(i => i.title === 'Post 3').error, 'Model unavailable');
        t.tick(31 * 60000);
        entry = await t.service.run('en');
        assert.equal(entry.errors, 0, 'paused after three failures');

        t.setOptions({});
        t.tick(6 * 3600000);
        const lastRun = t.service.status('en').lastRunAt;
        await t.service.tick();
        assert.notEqual(t.service.status('en').lastRunAt, lastRun, 'scheduled run');
        assert.equal(t.service.status('en').log[0].trigger, 'schedule');
        assert.equal(t.service.status('en').log[0].created, 1);

        const runAt = t.service.status('en').lastRunAt;
        t.tick(60000);
        await t.service.tick();
        assert.equal(t.service.status('en').lastRunAt, runAt, 'not before the interval');
    });
});
