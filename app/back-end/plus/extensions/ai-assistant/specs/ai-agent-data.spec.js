const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPubliiData } = require('../agent/publii-data');

const schema = fs.readFileSync(path.join(__dirname, '../../../../sql/1.0.0.sql'), 'utf8');

describe('Publii Plus: AI agent – website data on Publii models', () => {
    let dir;
    let db;
    let data;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-agent-db-'));
        fs.mkdirSync(path.join(dir, 'blog', 'input', 'config'), { recursive: true });
        const config = { name: 'blog', displayName: 'My blog', theme: 'simple', language: 'en', domain: 'https://example.com', advanced: { urls: {} } };
        fs.writeFileSync(path.join(dir, 'blog', 'input', 'config', 'site.config.json'), JSON.stringify(config));
        db = new DatabaseSync(':memory:');
        db.exec(schema);
        db.prepare("INSERT INTO authors VALUES(null, 'Anna', 'anna', '', '{}', '{}')").run();
        data = createPubliiData({ app: { appDir: path.resolve(__dirname, '../../../../..'), sitesDir: dir, sites: { blog: config }, getDbForSite: () => db } });
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('creates drafts, lists, reads and updates only the given fields', () => {
        const { id } = data.createPost('blog', { title: 'Hello world', text: '# Hi\n\nText', tags: ['News', 'Intro'], metaTitle: 'SEO', metaDescription: 'Desc' });
        assert.ok(id > 0);

        // something the agent must not touch: featured image reference and view settings
        db.prepare('UPDATE posts SET featured_image_id = 77 WHERE id = ?').run(id);
        db.prepare("UPDATE posts_additional_data SET value = '{\"x\":1}' WHERE post_id = ? AND key = 'postViewSettings'").run(id);
        db.prepare("UPDATE posts SET status = 'draft,featured' WHERE id = ?").run(id);

        const post = data.readPost('blog', id);
        assert.deepEqual([post.title, post.slug, post.status, post.flags, post.editor, post.tags, post.metaTitle, post.metaDescription, post.text],
            ['Hello world', 'hello-world', 'draft', ['featured'], 'markdown', ['Intro', 'News'], 'SEO', 'Desc', '# Hi\n\nText']);

        data.updatePost('blog', id, { title: 'Hello again', tags: ['News', 'Extra'], metaDescription: 'New desc', status: 'published' });
        const after = data.readPost('blog', id);
        assert.deepEqual([after.title, after.slug, after.status, after.flags, after.tags, after.metaTitle, after.metaDescription, after.editor],
            ['Hello again', 'hello-world', 'published', ['featured'], ['Extra', 'News'], 'SEO', 'New desc', 'markdown'], 'slug and other fields stay');
        assert.equal(db.prepare('SELECT featured_image_id AS f FROM posts WHERE id = ?').get(id).f, 77);
        assert.equal(db.prepare("SELECT value FROM posts_additional_data WHERE post_id = ? AND key = 'postViewSettings'").get(id).value, '{"x":1}');

        const list = data.listPosts('blog', { tag: 'extra' });
        assert.deepEqual(list.posts.map(p => [p.id, p.status, p.flags]), [[id, 'published', ['featured']]]);
        assert.equal(data.listPosts('blog', { status: 'draft' }).total, 0);
        assert.equal(data.listPosts('blog', { status: 'featured' }).total, 1);
        assert.equal(data.listPosts('blog', { query: 'again' }).total, 1);

        assert.deepEqual(data.listTags('blog').map(t => [t.name, t.posts]), [['Extra', 1], ['Intro', 0], ['News', 1]]);
        const info = data.siteInfo('blog');
        assert.deepEqual([info.name, info.posts, info.tags], ['My blog', { published: 1 }, 3]);

        const store = data.storeData('blog');
        assert.equal(store.posts.length, 1);
        assert.ok(Array.isArray(store.postsTags) && Array.isArray(store.authors));

        data.deletePost('blog', id);
        assert.throws(() => data.readPost('blog', id), /does not exist/);
    });

    it('does not treat pages as posts', () => {
        db.prepare("INSERT INTO posts VALUES(null, 'About', 1, 'about', 'x', 0, 1, 1, 'published,is-page', '')").run();
        const pageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        assert.throws(() => data.readPost('blog', pageId), /does not exist/);
        assert.equal(data.listPosts('blog').total, 0);
    });
});
