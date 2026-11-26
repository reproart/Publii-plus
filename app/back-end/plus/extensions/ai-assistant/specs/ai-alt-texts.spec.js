const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { listImages, applyAlts, needsAlt } = require('../alt-texts/images');
const { resolveFile, userPrompt } = require('../alt-texts/describe');
const { createAltService } = require('../alt-texts');

const schema = fs.readFileSync(path.join(__dirname, '../../../../sql/1.0.0.sql'), 'utf8');

function png (w, h) {
    const chunk = (t, d) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t), d])) >>> 0);
        return Buffer.concat([len, Buffer.from(t), d, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 120)]);
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

describe('Publii Plus: AI alt texts – images in content', () => {
    it('markdown: images and raw <img>, ids in document order, apply keeps the rest', () => {
        const text = 'Intro about the clinic.\n\n![](#DOMAIN_NAME#a.png)\n\nMiddle text ![Old](#DOMAIN_NAME#b.png "Title") and <img src="#DOMAIN_NAME#c.png">\n\nEnd.';
        const post = { text, editor: 'markdown', featured: { url: 'cover.png', alt: '' } };
        const images = listImages(post);

        assert.deepEqual(images.map(i => [i.id, i.kind, i.src, i.alt]), [
            ['featured', 'featured', 'cover.png', ''],
            ['c0', 'content', '#DOMAIN_NAME#a.png', ''],
            ['c1', 'content', '#DOMAIN_NAME#b.png', 'Old'],
            ['c2', 'content', '#DOMAIN_NAME#c.png', null]
        ]);
        assert.deepEqual(images.filter(needsAlt).map(i => i.id), ['featured', 'c0', 'c2']);
        assert.equal(images[2].caption, 'Title');
        assert.match(images[1].context.before, /Intro about the clinic/);
        assert.match(images[1].context.after, /Middle text/);

        const out = applyAlts(post, { featured: 'Clinic entrance', c0: 'Doctor [with] "patient"\n', c2: 'Chart: visits by month' });
        assert.equal(out.text, 'Intro about the clinic.\n\n![Doctor with \'patient\'](#DOMAIN_NAME#a.png)\n\nMiddle text ![Old](#DOMAIN_NAME#b.png "Title") and <img alt="Chart: visits by month" src="#DOMAIN_NAME#c.png">\n\nEnd.');
        assert.equal(out.featuredAlt, 'Clinic entrance');
        assert.equal(out.changed, 3);
    });

    it('HTML (TinyMCE): replaces or adds alt, figcaption as caption, data-alt is not alt', () => {
        const text = '<p>Text</p><figure class="post__image"><img src="#DOMAIN_NAME#x.jpg" alt="" data-alt="no" width="10"><figcaption>Our team</figcaption></figure><p><img src=\'#DOMAIN_NAME#y.jpg\'></p>';
        const post = { text, editor: 'tinymce', featured: null };
        const images = listImages(post);

        assert.deepEqual(images.map(i => [i.id, i.alt, i.caption]), [['c0', '', 'Our team'], ['c1', null, '']]);

        const out = applyAlts(post, { c0: 'Five doctors & nurses <smiling>', c1: 'Waiting room' });
        assert.equal(out.text, '<p>Text</p><figure class="post__image"><img src="#DOMAIN_NAME#x.jpg" alt="Five doctors &amp; nurses &lt;smiling&gt;" data-alt="no" width="10"><figcaption>Our team</figcaption></figure><p><img alt="Waiting room" src=\'#DOMAIN_NAME#y.jpg\'></p>');
    });

    it('block editor: image, gallery and HTML blocks; empty alts are not written', () => {
        const blocks = [
            { id: 1, type: 'publii-paragraph', content: 'Before the photo.', config: {} },
            { id: 2, type: 'publii-image', content: { image: '#DOMAIN_NAME#p.jpg', alt: '', caption: 'Lobby', imageWidth: 10, imageHeight: 10 }, config: {} },
            { id: 3, type: 'publii-gallery', content: { images: [{ src: '#DOMAIN_NAME#gallery/g1.jpg', thumbnailSrc: '#DOMAIN_NAME#gallery/g1-thumbnail.jpg', alt: '', caption: '' }, { src: '#DOMAIN_NAME#gallery/g2.jpg', alt: 'Set', caption: '' }] }, config: {} },
            { id: 4, type: 'publii-html', content: '<img src="#DOMAIN_NAME#h.png">', config: {} }
        ];
        const post = { text: JSON.stringify(blocks), editor: 'blockeditor', featured: null };
        const images = listImages(post);

        assert.deepEqual(images.map(i => [i.id, i.kind, i.src]), [['c0', 'content', '#DOMAIN_NAME#p.jpg'], ['c1', 'gallery', '#DOMAIN_NAME#gallery/g1.jpg'], ['c2', 'gallery', '#DOMAIN_NAME#gallery/g2.jpg'], ['c3', 'content', '#DOMAIN_NAME#h.png']]);
        assert.equal(images[0].caption, 'Lobby');
        assert.equal(images[0].context.before, 'Before the photo.');

        const out = applyAlts(post, { c0: 'Hospital lobby', c1: 'Reception desk', c3: 'Logo', c2: '   ' });
        const saved = JSON.parse(out.text);
        assert.equal(saved[1].content.alt, 'Hospital lobby');
        assert.equal(saved[2].content.images[0].alt, 'Reception desk');
        assert.equal(saved[2].content.images[1].alt, 'Set', 'blank proposals are ignored');
        assert.equal(saved[3].content, '<img alt="Logo" src="#DOMAIN_NAME#h.png">');
        assert.equal(out.changed, 3);
        assert.equal(applyAlts({ text: 'not json', editor: 'blockeditor' }, { c0: 'x' }).text, 'not json');
    });

    it('prompt names the context; files resolve inside the media folder only', () => {
        const prompt = userPrompt({ title: 'Clinic', image: { kind: 'featured', src: '#DOMAIN_NAME#cover.jpg?x=1', caption: 'Cap', context: { before: 'B', after: 'A' } } });
        assert.match(prompt, /Article title: Clinic[\s\S]*featured \(cover\)[\s\S]*Text before the image: B[\s\S]*Caption shown under the image: Cap[\s\S]*File name: cover\.jpg/);

        const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-site-'));
        fs.mkdirSync(path.join(siteDir, 'input', 'media', 'posts', '5'), { recursive: true });
        fs.writeFileSync(path.join(siteDir, 'input', 'media', 'posts', '5', 'a b.png'), png(4, 4));
        assert.equal(resolveFile('#DOMAIN_NAME#a%20b.png', { siteDir, postId: 5 }), path.join(siteDir, 'input', 'media', 'posts', '5', 'a b.png'));
        assert.equal(resolveFile('https://cdn.example.org/a.png', { siteDir, postId: 5 }), null);
        assert.equal(resolveFile('#DOMAIN_NAME#../../../../etc/passwd', { siteDir, postId: 5 }), null);
    });
});

describe('Publii Plus: AI alt texts – service', () => {
    function setup () {
        const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-svc-'));
        const media = path.join(siteDir, 'input', 'media', 'posts');
        fs.mkdirSync(path.join(media, '1', 'responsive'), { recursive: true });
        fs.mkdirSync(path.join(media, '2'), { recursive: true });
        fs.writeFileSync(path.join(media, '1', 'photo.png'), png(2400, 1600));
        fs.writeFileSync(path.join(media, '1', 'responsive', 'photo-sm.png'), png(640, 427));
        fs.writeFileSync(path.join(media, '1', 'responsive', 'photo-lg.png'), png(1200, 800));
        fs.writeFileSync(path.join(media, '1', 'cover.png'), png(300, 200));
        fs.writeFileSync(path.join(media, '2', 'p.png'), png(100, 100));

        const db = new DatabaseSync(':memory:');
        db.exec(schema);
        const insert = db.prepare('INSERT INTO posts (id, title, authors, slug, text, featured_image_id, created_at, modified_at, status, template) VALUES (?, ?, 1, ?, ?, 0, 1, 1, ?, \'\')');
        insert.run(1, 'Clinic news', 'clinic-news', 'Our new building.\n\n![](#DOMAIN_NAME#photo.png)\n\n![Has alt](#DOMAIN_NAME#photo.png)\n\n![](https://cdn.example.org/x.png)', 'published');
        insert.run(2, 'About', 'about', '<p><img src="#DOMAIN_NAME#p.png" alt=""></p>', 'published,is-page');
        insert.run(3, 'Gone', 'gone', '![](#DOMAIN_NAME#p.png)', 'trashed');
        db.prepare("INSERT INTO posts_additional_data VALUES (null, 1, '_core', ?)").run(JSON.stringify({ editor: 'markdown' }));
        db.prepare("INSERT INTO posts_images VALUES (null, 1, 'cover.png', '', '', ?)").run(JSON.stringify({ alt: '', caption: 'Front', credits: 'Me' }));

        const calls = [];
        let clock = 100;
        const service = createAltService({
            db: () => db,
            siteDir: () => siteDir,
            language: () => 'ru',
            resolveProvider: async id => ({ provider: { id: id || 'p', model: 'vision', type: 'openai-chat' }, apiKey: 'k' }),
            generate: async options => {
                calls.push(options);
                return { data: { alt: '«Новое здание клиники»', decorative: false } };
            },
            instructions: () => s => s + '\nOWNER RULES',
            now: () => ++clock
        });

        return { service, db, calls, siteDir };
    }

    it('scan lists posts and pages with images that need alt text', () => {
        const { service } = setup();
        const found = service.scan('blog');

        assert.deepEqual(found.map(p => [p.postId, p.type, p.editor, p.images.map(i => i.id)]), [
            [1, 'post', 'markdown', ['featured', 'c0', 'c2']],
            [2, 'page', 'tinymce', ['c0']]
        ]);
        assert.equal(found[0].images[2].describable, false);
        assert.equal(found[0].images[2].reason, 'external image');
        assert.match(found[0].images[1].thumb, /^file:\/\/.*responsive\/photo-sm\.png$/, 'small responsive copy as thumbnail');
        assert.deepEqual(service.scan('blog', { postIds: [2] }).map(p => p.postId), [2]);
    });

    it('describe sends a downscaled image with context and the owner instructions', async () => {
        const { service, calls } = setup();
        const out = await service.describe('blog', 1, 'c0', { providerId: 'vis' });

        assert.deepEqual(out, { alt: 'Новое здание клиники', decorative: false, src: '#DOMAIN_NAME#photo.png' });
        assert.equal(calls[0].config.id, 'vis');
        assert.match(calls[0].system, /language with code "ru"[\s\S]*OWNER RULES$/);
        assert.match(calls[0].user, /Article title: Clinic news[\s\S]*Text before the image: Our new building\./);
        assert.equal(calls[0].images.length, 1);
        assert.ok(calls[0].images[0].startsWith('data:image/png;base64,'));
        assert.ok(Buffer.from(calls[0].images[0].split(',')[1], 'base64').length < fs.statSync(path.join(setup().siteDir, 'input', 'media', 'posts', '1', 'photo.png')).size, 'the 1200 px copy, not the original');
        await assert.rejects(service.describe('blog', 1, 'c2'), /file was not found/);
        await assert.rejects(service.describe('blog', 3, 'c0'), /no longer exists/);
    });

    it('apply writes text and featured alt, skips images changed meanwhile, undo restores', () => {
        const { service, db } = setup();
        const before = db.prepare('SELECT text FROM posts WHERE id = 1').get().text;

        const result = service.apply('blog', [
            { postId: 1, alts: { featured: 'Main entrance', c0: 'New building', c1: 'ignored?' }, srcs: { c0: '#DOMAIN_NAME#photo.png', c1: '#DOMAIN_NAME#other.png' } },
            { postId: 2, alts: { c0: 'Team photo' } },
            { postId: 99, alts: { c0: 'x' } }
        ]);

        assert.deepEqual({ ...result, undoId: !!result.undoId }, { posts: 2, images: 3, skipped: 2, undoId: true });
        const text = db.prepare('SELECT text, modified_at FROM posts WHERE id = 1').get();
        assert.match(text.text, /!\[New building\]\(#DOMAIN_NAME#photo\.png\)\n\n!\[Has alt\]/);
        assert.ok(text.modified_at > 1);
        assert.deepEqual(JSON.parse(db.prepare('SELECT additional_data FROM posts_images WHERE post_id = 1').get().additional_data), { alt: 'Main entrance', caption: 'Front', credits: 'Me' });
        assert.equal(db.prepare('SELECT text FROM posts WHERE id = 2').get().text, '<p><img src="#DOMAIN_NAME#p.png" alt="Team photo"></p>');
        assert.deepEqual(service.scan('blog').map(p => [p.postId, p.images.map(i => i.id)]), [[1, ['c2']]]);

        assert.deepEqual(service.undo(result.undoId), { posts: 2 });
        assert.equal(db.prepare('SELECT text FROM posts WHERE id = 1').get().text, before);
        assert.equal(JSON.parse(db.prepare('SELECT additional_data FROM posts_images WHERE post_id = 1').get().additional_data).alt, '');
        assert.throws(() => service.undo(result.undoId), /Nothing to undo/);
    });
});
