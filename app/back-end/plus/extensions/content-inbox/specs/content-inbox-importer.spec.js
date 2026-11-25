const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPubliiData } = require('../../ai-assistant/agent/publii-data');
const { createImporter, postFields, findImages } = require('../importer');
const { createSource } = require('../sources');

const schema = fs.readFileSync(path.join(__dirname, '../../../../sql/1.0.0.sql'), 'utf8');

function setup () {
    const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-site-'));
    const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-files-'));
    const config = { name: 'blog', theme: 'simple', advanced: { urls: {} } };
    fs.mkdirSync(path.join(sitesDir, 'blog', 'input', 'config'), { recursive: true });
    fs.writeFileSync(path.join(sitesDir, 'blog', 'input', 'config', 'site.config.json'), JSON.stringify(config));
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    db.prepare("INSERT INTO authors VALUES(null, 'Anna', 'anna', '', '{}', '{}')").run();
    const data = createPubliiData({ app: { appDir: path.resolve(__dirname, '../../../../..'), sitesDir, sites: { blog: config }, getDbForSite: () => db } });
    const uploads = [];
    let clock = Date.now();
    const importer = createImporter({
        data,
        now: () => clock,
        uploadImage: async (site, postId, buffer, name, type) => {
            uploads.push({ postId, name, type });
            const dir = data.mediaDir(site, postId);
            fs.mkdirSync(dir, { recursive: true });
            const filename = fs.existsSync(path.join(dir, name)) ? name.replace(/(\.\w+)$/, '-1$1') : name;
            fs.writeFileSync(path.join(dir, filename), buffer);
            return filename;
        }
    });
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(inbox, rel)), { recursive: true }); fs.writeFileSync(path.join(inbox, rel), text); };
    const state = { files: {} };
    const run = (config = {}, dryRun = false) => importer.run({ site: 'blog', source: createSource({ source: 'folder', dir: inbox }), config, state, dryRun });
    return { db, data, write, run, state, uploads, inbox, tick: ms => { clock += ms; } };
}

describe('Publii Plus: content inbox – mapping Markdown to posts', () => {
    it('reads front matter, H1 title, dates, status and images', () => {
        const f = postFields('---\ntitle: Hello\ndate: 2026-11-20 10:30\ntags: a, b\ndraft: true\nfeatured: true\ndescription: Short\nimage: img/cover.jpg\nimage_alt: Cover\n---\n# Hello\n\nText ![x](img/a.png "t") <img src="./img/b.png">\n', 'news/hello.md');
        assert.equal(f.title, 'Hello');
        assert.equal(f.body.startsWith('Text'), true, 'duplicate H1 removed');
        assert.equal(f.date, Date.parse('2026-11-20T10:30'));
        assert.deepEqual(f.tags, ['a', 'b']);
        assert.equal(f.status, 'draft');
        assert.deepEqual(f.flags, ['featured']);
        assert.deepEqual(f.featured, { path: 'news/img/cover.jpg', alt: 'Cover', caption: '', credits: '' });
        assert.deepEqual(findImages(f.body, 'news/hello.md').map(i => i.path), ['news/img/a.png', 'news/img/b.png']);
        assert.deepEqual(findImages('![](https://x.y/a.png) ![](/a.png) ![](../../etc/x.png) ![](doc.pdf)', 'a.md'), []);

        assert.equal(postFields('# From heading\n\nBody', '2026-01-01-x.md').title, 'From heading');
        assert.equal(postFields('Body only', 'posts/2026-01-01-my-first_post.md').title, 'My first post');
        assert.equal(postFields('Body', 'a.md', { defaultStatus: 'published' }).status, 'published');
        assert.equal(postFields('Body', 'a.md', { defaultStatus: 'draft' }).status, 'draft');
        assert.match(postFields('---\ndate: tomorrow\n---\n', 'a.md').error, /Invalid date/);
    });

    it('creates, updates, skips unchanged, protects local edits, handles removed files', async () => {
        const t = setup();
        t.write('hello.md', '---\ntitle: Hello world\ntags: [News]\nimage: img/cover.png\ndescription: Meta\n---\nIntro ![Pic](img/pic.png)\n');
        t.write('img/pic.png', 'PIC');
        t.write('img/cover.png', 'COVER');
        t.write('README.md', '# Inbox readme');
        t.write('_drafts/ignored.md', 'x');

        const dry = await t.run({}, true);
        assert.deepEqual(dry.items.map(i => [i.path, i.action]), [['hello.md', 'create']]);
        assert.equal(Object.keys(t.state.files).length, 0, 'dry run changes nothing');

        const first = await t.run({ defaultStatus: 'published' });
        assert.equal(first.created, 1);
        const id = t.state.files['hello.md'].postId;
        const post = t.data.readPost('blog', id);
        assert.deepEqual([post.title, post.slug, post.status, post.editor, post.tags, post.metaDescription], ['Hello world', 'hello-world', 'published', 'markdown', ['News'], 'Meta']);
        assert.equal(post.text, 'Intro ![Pic](#DOMAIN_NAME#pic.png)\n');
        assert.ok(fs.existsSync(path.join(t.data.mediaDir('blog', id), 'pic.png')));
        const featured = t.db.prepare('SELECT pi.url AS url, pi.additional_data AS d FROM posts p JOIN posts_images pi ON pi.id = p.featured_image_id WHERE p.id = ?').get(id);
        assert.equal(featured.url, 'cover.png');
        assert.deepEqual(t.uploads.map(u => [u.name, u.type]), [['pic.png', 'contentImages'], ['cover.png', 'featuredImages']]);

        t.tick(10000);
        assert.deepEqual((await t.run()).items.map(i => i.action), ['unchanged']);

        // text changed -> same post updated, unchanged images are not uploaded again
        t.write('hello.md', '---\ntitle: Hello again\ntags: [News, Extra]\nimage: img/cover.png\n---\nNew intro ![Pic](img/pic.png)\n');
        t.tick(10000);
        const second = await t.run();
        assert.equal(second.updated, 1);
        assert.equal(t.data.readPost('blog', id).title, 'Hello again');
        assert.equal(t.data.readPost('blog', id).slug, 'hello-world', 'URL kept when the front matter has no slug');
        assert.equal(t.uploads.length, 2);

        // only an image changed -> post updated, image uploaded again
        t.write('img/pic.png', 'PIC2');
        t.tick(10000);
        assert.equal((await t.run()).updated, 1);
        assert.equal(t.uploads.length, 3);

        // edited in Publii -> conflict, unless overwrite is allowed
        t.tick(10000);
        t.db.prepare('UPDATE posts SET modified_at = ? WHERE id = ?').run(Date.now() + 60000, id);
        t.write('hello.md', '---\ntitle: Third\n---\nText');
        const conflict = await t.run();
        assert.deepEqual(conflict.items.map(i => [i.action, i.reason]), [['conflict', 'the post was edited in Publii after the last import']]);
        assert.equal(t.data.readPost('blog', id).title, 'Hello again');
        assert.equal((await t.run({ overwriteLocalEdits: true })).updated, 1);
        assert.equal(t.data.readPost('blog', id).title, 'Third');

        // removed from the inbox -> unpublished with onDelete: draft, reported once
        fs.rmSync(path.join(t.inbox, 'hello.md'));
        const removed = await t.run({ onDelete: 'draft' });
        assert.equal(removed.unpublished, 1);
        assert.equal(t.data.readPost('blog', id).status, 'draft');
        assert.deepEqual((await t.run({ onDelete: 'draft' })).items, []);
    });

    it('errors are per file, posts deleted in Publii are not re-imported, no duplicates after a failed image', async () => {
        const t = setup();
        t.write('bad.md', '---\ntitle: Bad\n  nested: x\n---\n');
        t.write('missing-image.md', '# Pic post\n\n![a](nope.png)');
        t.write('ok.md', '# Fine\n\nText');

        const out = await t.run();
        const byPath = Object.fromEntries(out.items.map(i => [i.path, [i.action, i.reason || '']]));
        assert.match(byPath['bad.md'][1], /Front matter/);
        assert.match(byPath['missing-image.md'][1], /Image not found/);
        assert.equal(byPath['ok.md'][0], 'create');
        assert.equal(out.errors, 2);

        const posts = () => t.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
        assert.equal(posts(), 2, 'the post of the failed image exists once');
        t.write('nope.png', 'X');
        t.tick(10000);
        assert.equal((await t.run()).updated, 1, 'next run updates it');
        assert.equal(posts(), 2);

        t.data.deletePost('blog', t.state.files['ok.md'].postId);
        t.write('ok.md', '# Fine\n\nChanged');
        const after = await t.run();
        assert.deepEqual(after.items.find(i => i.path === 'ok.md').action, 'skip');
        assert.equal(posts(), 1);
    });
});
