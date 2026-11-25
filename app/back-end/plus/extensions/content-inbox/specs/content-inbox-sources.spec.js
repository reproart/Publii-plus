const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFrontMatter } = require('../front-matter');
const { createSource, gitBlobSha } = require('../sources');

describe('Publii Plus: content inbox – front matter', () => {
    it('parses the supported YAML subset', () => {
        const { data, body, errors } = parseFrontMatter([
            '---',
            'title: "Healthcare: the paradox"',
            'slug: healthcare-paradox',
            "subtitle: 'It''s here'",
            'date: 2026-11-20 10:30',
            'draft: false',
            'featured: yes',
            'weight: 3',
            'tags: [news, "Medicine, research", ]',
            'categories:',
            '  - one',
            '  - "two"',
            'description: >',
            '  Folded text',
            '  on two lines.',
            'notes: |',
            '  Line 1',
            '  Line 2',
            '# a comment',
            'empty:',
            '---',
            '# Body',
            ''
        ].join('\n'));

        assert.deepEqual(errors, []);
        assert.deepEqual(data, {
            title: 'Healthcare: the paradox',
            slug: 'healthcare-paradox',
            subtitle: "It's here",
            date: '2026-11-20 10:30',
            draft: false,
            featured: true,
            weight: 3,
            tags: ['news', 'Medicine, research'],
            categories: ['one', 'two'],
            description: 'Folded text on two lines.',
            notes: 'Line 1\nLine 2',
            empty: null
        });
        assert.equal(body, '# Body\n');
    });

    it('files without front matter, CRLF and broken lines', () => {
        assert.deepEqual(parseFrontMatter('Just text').data, {});
        assert.equal(parseFrontMatter('﻿---\r\ntitle: A\r\n---\r\nText').data.title, 'A');
        const broken = parseFrontMatter('---\ntitle: A\n  nested: x\n---\n');
        assert.match(broken.errors[0], /line 2/);
    });
});

describe('Publii Plus: content inbox – sources', () => {
    it('local folder: lists files with git blob hashes, refuses paths outside', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-src-'));
        fs.mkdirSync(path.join(dir, 'img'));
        fs.mkdirSync(path.join(dir, '.git'));
        fs.writeFileSync(path.join(dir, 'post.md'), '# Hi\n');
        fs.writeFileSync(path.join(dir, 'img', 'a.png'), 'png');
        fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');

        const source = createSource({ source: 'folder', dir });
        const list = await source.list();
        assert.deepEqual(list.map(f => f.path).sort(), ['img/a.png', 'post.md']);
        assert.equal(list.find(f => f.path === 'post.md').sha, gitBlobSha(Buffer.from('# Hi\n')));
        assert.equal(gitBlobSha(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'same as git hash-object');
        assert.equal((await source.read('post.md')).toString(), '# Hi\n');
        await assert.rejects(source.read('../etc/passwd'), /Invalid file path/);
        assert.throws(() => createSource({ source: 'folder', dir: path.join(dir, 'missing') }), /does not exist/);
    });

    it('GitHub: tree of one folder, blobs, token and readable errors', async () => {
        const calls = [];
        const files = { 'posts/a.md': 'A', 'posts/img/x.png': 'PNG', 'README.md': 'root' };
        const fetchImpl = async (url, init) => {
            calls.push({ url, auth: init.headers.Authorization });

            if (url.includes('/git/trees/main')) {
                return { ok: true, json: async () => ({ tree: [...Object.keys(files).map(p => ({ path: p, type: 'blob', sha: 'sha-' + p, size: files[p].length })), { path: 'posts', type: 'tree' }] }) };
            }

            const m = url.match(/\/git\/blobs\/sha-(.+)$/);

            if (m) return { ok: true, json: async () => ({ encoding: 'base64', content: Buffer.from(files[m[1]]).toString('base64') }) };
            return { ok: false, status: 404 };
        };
        const source = createSource({ source: 'github', repo: 'me/site', branch: 'main', folder: '/posts/' }, { token: 't0k', apiBase: 'https://api.test', fetchImpl });
        const list = await source.list();
        assert.deepEqual(list.map(f => f.path), ['a.md', 'img/x.png']);
        assert.equal((await source.read('img/x.png')).toString(), 'PNG');
        assert.equal(calls[0].auth, 'Bearer t0k');
        assert.equal(calls[1].url, 'https://api.test/repos/me/site/git/blobs/sha-posts/img/x.png');

        const missing = createSource({ source: 'github', repo: 'me/site', branch: 'nope' }, { apiBase: 'https://api.test', fetchImpl });
        await assert.rejects(missing.list(), /HTTP 404 – repository, branch or folder not found/);
        assert.throws(() => createSource({ source: 'github', repo: 'bad' }), /owner\/name/);
        assert.throws(() => createSource({ source: 'github', repo: 'a/b', folder: '../x' }), /Invalid folder/);
    });
});
