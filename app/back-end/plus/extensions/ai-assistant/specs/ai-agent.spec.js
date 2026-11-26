const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROTOCOLS, chat } = require('../providers');
const { createAgent } = require('../agent');
const { contentFor } = require('../agent/tools');
const themeEditor = require('../../theme-editor');
const { createUnifiedDiff } = require('../../../lib/unified-diff');

const TOOLS = [{ name: 'read_post', description: 'd', parameters: { type: 'object', properties: { id: { type: 'integer' } } } }];
const HISTORY = [
    { role: 'user', text: 'Fix post 1' },
    { role: 'assistant', text: 'Reading.', toolCalls: [{ id: 'c1', name: 'read_post', arguments: '{"id":1}' }] },
    { role: 'tool', id: 'c1', name: 'read_post', output: '{"title":"A"}' }
];

describe('Publii Plus: AI agent – tool calling protocols', () => {
    it('Chat Completions: tools, tool_calls and tool results', async () => {
        const { path: p, body } = PROTOCOLS['openai-chat'].buildChat({ config: { model: 'm' }, system: 'S', messages: HISTORY, tools: TOOLS });
        assert.equal(p, '/chat/completions');
        assert.deepEqual(body.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
        assert.deepEqual(body.messages[2].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'read_post', arguments: '{"id":1}' } }]);
        assert.equal(body.messages[3].tool_call_id, 'c1');
        assert.equal(body.tools[0].function.name, 'read_post');

        const parsed = PROTOCOLS['openai-chat'].parseChat({
            model: 'm',
            choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'x', function: { name: 'list_tags', arguments: { a: 1 } } }] } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 }
        });
        assert.deepEqual(parsed.toolCalls, [{ id: 'x', name: 'list_tags', arguments: '{"a":1}' }], 'object arguments (Ollama) become JSON text');
        assert.deepEqual(parsed.usage, { input: 5, output: 2 });
    });

    it('Responses API: function_call items are replayed with their reasoning', async () => {
        const json = {
            model: 'm',
            output: [
                { type: 'reasoning', id: 'rs_1', summary: [] },
                { type: 'function_call', call_id: 'c9', name: 'list_posts', arguments: '{}' }
            ],
            usage: { input_tokens: 10, output_tokens: 3 }
        };
        let sent = null;
        const fetchImpl = async (url, init) => {
            sent = { url, body: JSON.parse(init.body) };
            return { ok: true, status: 200, text: async () => JSON.stringify(json), headers: { get: () => 'application/json' } };
        };
        const out = await chat({ config: { type: 'openai-responses', baseUrl: 'http://x/v1/', model: 'm' }, apiKey: 'k', system: 'S', messages: [{ role: 'user', text: 'hi' }], tools: TOOLS, fetchImpl });

        assert.equal(sent.url, 'http://x/v1/responses');
        assert.deepEqual(sent.body.tools[0], { type: 'function', name: 'read_post', description: 'd', parameters: TOOLS[0].parameters });
        assert.deepEqual(out.toolCalls, [{ id: 'c9', name: 'list_posts', arguments: '{}' }]);

        const next = PROTOCOLS['openai-responses'].buildChat({
            config: { model: 'm' },
            system: 'S',
            messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '', toolCalls: out.toolCalls, raw: out.raw }, { role: 'tool', id: 'c9', output: '[]' }],
            tools: TOOLS
        });
        assert.deepEqual(next.body.input.map(i => i.type || i.role), ['user', 'reasoning', 'function_call', 'function_call_output']);
    });
});

function fakeData () {
    const posts = {
        1: { id: 1, title: 'Hello', slug: 'hello', status: 'published', flags: [], editor: 'markdown', tags: ['news'], metaTitle: '', metaDescription: '', text: 'Old text\n' },
        2: { id: 2, title: 'Blocks', slug: 'blocks', status: 'draft', flags: [], editor: 'blockeditor', tags: [], metaTitle: '', metaDescription: '', text: '[]' }
    };
    let nextId = 3;

    return {
        posts,
        siteInfo: site => ({ site, name: 'Test site', domain: 'https://example.com', language: 'en', theme: 'simple', posts: { published: 1 }, tags: 1 }),
        listPosts: () => ({ total: 2, posts: Object.values(posts).map(p => ({ id: p.id, title: p.title })) }),
        readPost: (site, id) => {
            if (!posts[id]) throw new Error(`Post ${id} does not exist.`);
            return JSON.parse(JSON.stringify(posts[id]));
        },
        listTags: () => [{ name: 'news', posts: 1 }],
        createPost: (site, f) => {
            const id = nextId++;
            posts[id] = { id, title: f.title, status: 'draft', flags: [], editor: f.editor, tags: f.tags, metaTitle: f.metaTitle, metaDescription: f.metaDescription, text: f.text };
            return { id };
        },
        updatePost: (site, id, fields) => { Object.assign(posts[id], fields); return { id }; },
        deletePost: (site, id) => { delete posts[id]; return true; }
    };
}

function makeSite () {
    const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-agent-'));
    const site = path.join(sitesDir, 'blog');
    fs.mkdirSync(path.join(site, 'input', 'config'), { recursive: true });
    fs.mkdirSync(path.join(site, 'input', 'themes', 'simple', 'partials'), { recursive: true });
    fs.writeFileSync(path.join(site, 'input', 'config', 'site.config.json'), JSON.stringify({ theme: 'simple' }));
    fs.writeFileSync(path.join(site, 'input', 'themes', 'simple', 'partials', 'footer.hbs'), '<footer>{{site.name}}</footer>\n');
    return sitesDir;
}

/** Scripted model: each step is (messages) -> { text, toolCalls } */
function scripted (steps) {
    const seen = [];
    return {
        seen,
        chat: async ({ messages, tools, system }) => {
            seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools: tools.map(t => t.name), system });
            const step = steps.shift();

            if (!step) throw new Error('no more scripted steps');

            const out = typeof step === 'function' ? step(messages) : step;
            return { text: out.text || '', toolCalls: (out.toolCalls || []).map((c, i) => ({ id: c.id || `call${seen.length}_${i}`, name: c.name, arguments: JSON.stringify(c.args || {}) })), usage: { input: 10, output: 5 }, model: 'fake' };
        }
    };
}

function makeAgent (model, data = fakeData(), inbox = null, siteCheck = null, altTexts = null) {
    const sitesDir = makeSite();
    const theme = themeEditor.createService({ getSitesDir: () => sitesDir });
    const agent = createAgent({
        resolveProvider: async () => ({ provider: { model: 'fake', type: 'openai-chat' }, apiKey: '' }),
        chat: model.chat,
        getInstructions: () => ({ global: 'Always be polite.', site: '' }),
        withInstructions: (s, i) => s + '\n' + i.global,
        makeContext: site => ({
            site,
            data,
            inbox,
            siteCheck,
            altTexts,
            theme,
            markdownToHtml: md => '<p>' + md.trim() + '</p>',
            createDiff: (a, b, name) => createUnifiedDiff(a, b, { oldName: 'a/' + name, newName: 'b/' + name })
        })
    });
    return { agent, data, sitesDir };
}

describe('Publii Plus: AI agent – loop', () => {
    it('runs read tools at once and waits for approval of changes; undo restores the post', async () => {
        const model = scripted([
            { text: 'Let me look.', toolCalls: [{ name: 'list_posts', args: {} }, { name: 'read_post', args: { id: 1 } }] },
            { toolCalls: [{ id: 'up', name: 'update_post', args: { id: 1, title: 'Hello world', content_markdown: 'New text\n', tags: ['news', 'intro'] } }] },
            messages => {
                const last = messages[messages.length - 1];
                assert.equal(last.role, 'tool');
                assert.deepEqual(JSON.parse(last.output), { ok: true, id: 1, changed: ['title', 'text', 'tags'] });
                return { text: 'Done: renamed and rewritten.' };
            }
        ]);
        const { agent, data } = makeAgent(model);
        const { sessionId, site } = agent.start({ site: 'blog' });
        assert.equal(site.name, 'Test site');

        const first = await agent.send(sessionId, 'Rename the hello post');
        assert.deepEqual(first.entries.map(e => [e.type, e.name || '', e.status || '']), [
            ['user', '', ''], ['assistant', '', ''], ['tool', 'list_posts', 'done'], ['tool', 'read_post', 'done'], ['tool', 'update_post', 'pending']
        ]);
        assert.match(model.seen[0].system, /Test site[\s\S]*Always be polite/);
        assert.ok(model.seen[0].tools.includes('write_theme_file'));

        const proposal = first.entries[4];
        assert.equal(proposal.title, 'Update post "Hello" (id 1)');
        assert.match(proposal.diff, /-Old text\n\+New text/);
        assert.deepEqual(first.pending.map(p => p.callId), ['up']);
        assert.equal(data.posts[1].title, 'Hello', 'nothing changes before approval');

        const second = await agent.resolve(sessionId, { up: { approve: true } });
        assert.equal(data.posts[1].title, 'Hello world');
        assert.deepEqual(data.posts[1].tags, ['news', 'intro']);
        assert.deepEqual(second.refresh, [{ kind: 'posts', postId: 1 }]);
        assert.equal(second.entries.at(-1).text, 'Done: renamed and rewritten.');
        assert.equal(second.changes.length, 1);
        assert.deepEqual(second.usage, { input: 30, output: 15 });

        const undone = agent.undo(sessionId, proposal.id);
        assert.equal(undone.changes[0].undone, true);
        assert.equal(data.posts[1].title, 'Hello');
        assert.equal(data.posts[1].text, 'Old text\n');
        assert.deepEqual(data.posts[1].tags, ['news']);
    });

    it('rejections and tool errors go back to the model; a new message rejects open proposals', async () => {
        const model = scripted([
            { toolCalls: [{ id: 'a', name: 'create_post', args: { title: 'Draft one', content_markdown: '# Hi\n\nText', tags: ['x'] } }, { id: 'b', name: 'read_post', args: { id: 99 } }, { id: 'c', name: 'update_post', args: { id: 2, content_markdown: 'x' } }] },
            messages => {
                const results = messages.filter(m => m.role === 'tool').map(m => [m.id, JSON.parse(m.output)]);
                assert.deepEqual(results.find(r => r[0] === 'b')[1], { error: 'Post 99 does not exist.' });
                assert.match(results.find(r => r[0] === 'c')[1].error, /block editor/);
                assert.deepEqual(results.find(r => r[0] === 'a')[1], { rejected: true, reason: 'Make it longer' });
                return { toolCalls: [{ id: 'd', name: 'create_post', args: { title: 'Draft two', content_markdown: 'Longer text' } }] };
            },
            { text: 'Created.' },
            { toolCalls: [{ id: 'e', name: 'preview_site' }] },
            messages => {
                assert.equal(messages.at(-1).text, 'No, never mind');
                assert.deepEqual(JSON.parse(messages.at(-2).output), { rejected: true, reason: 'The user wrote a new message instead.' });
                return { text: 'fine' };
            }
        ]);
        const { agent, data } = makeAgent(model);
        const { sessionId } = agent.start({ site: 'blog' });

        const first = await agent.send(sessionId, 'Write a draft');
        assert.deepEqual(first.entries.slice(1).map(e => [e.name, e.status]), [['create_post', 'pending'], ['read_post', 'error'], ['update_post', 'error']]);
        assert.match(first.entries[1].diff, /^--- \/dev\/null\n\+\+\+ b\/content\.md/);

        await agent.resolve(sessionId, { a: { approve: false, reason: 'Make it longer' } });
        assert.equal(Object.keys(data.posts).length, 2, 'rejected: nothing created');

        const pendingNow = agent.history(sessionId).pending;
        assert.deepEqual(pendingNow.map(p => p.callId), ['d']);
        const done = await agent.resolve(sessionId, { d: { approve: true } });
        assert.equal(data.posts[3].title, 'Draft two');
        assert.equal(data.posts[3].status, 'draft');
        assert.equal(done.entries.at(-1).text, 'Created.');

        // client tool waits for the renderer; a new message instead rejects it
        const preview = await agent.send(sessionId, 'Show me');
        assert.deepEqual(preview.pending, [{ callId: 'e', entryId: preview.entries.at(-1).id, name: 'preview_site', kind: 'client' }]);
        const after = await agent.send(sessionId, 'No, never mind');
        assert.equal(after.entries[0].status, 'rejected');
        assert.equal(after.entries.at(-1).text, 'fine');
    });

    it('edits theme files through the override with validation; auto-approve; undo removes the copy', async () => {
        const model = scripted([
            { toolCalls: [{ id: 'bad', name: 'write_theme_file', args: { path: 'partials/footer.hbs', content: '{{#if}}<footer>' } }] },
            { toolCalls: [{ id: 'ok', name: 'write_theme_file', args: { path: 'partials/footer.hbs', content: '<footer>{{site.name}} ©</footer>\n' } }] },
            { text: 'Footer updated.' }
        ]);
        const { agent, sitesDir } = makeAgent(model);
        const { sessionId } = agent.start({ site: 'blog', autoApprove: true });
        const out = await agent.send(sessionId, 'Add © to the footer');
        const override = path.join(sitesDir, 'blog', 'input', 'themes', 'simple-override', 'partials', 'footer.hbs');

        assert.deepEqual(out.entries.filter(e => e.type === 'tool').map(e => [e.callId, e.status]), [['bad', 'error'], ['ok', 'applied']]);
        assert.match(out.entries[1].error, /errors/);
        assert.equal(fs.readFileSync(override, 'utf8'), '<footer>{{site.name}} ©</footer>\n');
        assert.equal(fs.readFileSync(path.join(sitesDir, 'blog', 'input', 'themes', 'simple', 'partials', 'footer.hbs'), 'utf8'), '<footer>{{site.name}}</footer>\n', 'theme untouched');
        assert.deepEqual(out.refresh, [{ kind: 'theme', postId: null }]);

        agent.undo(sessionId, out.entries.find(e => e.callId === 'ok').id);
        assert.equal(fs.existsSync(override), false);
    });

    it('stops runaway loops, reports provider errors and converts markdown for TinyMCE posts', async () => {
        const forever = { chat: async () => ({ text: '', toolCalls: [{ id: 'x' + Math.random(), name: 'list_tags', arguments: '{}' }], usage: { input: 1, output: 1 } }) };
        const { agent } = makeAgent(forever);
        const { sessionId } = agent.start({ site: 'blog' });
        const out = await agent.send(sessionId, 'loop');
        assert.match(out.entries.at(-1).text, /Stopped after 16 steps/);

        const failing = { chat: async () => { throw new Error('HTTP 401: invalid key'); } };
        const { agent: a2 } = makeAgent(failing);
        const s2 = a2.start({ site: 'blog' });
        const err = await a2.send(s2.sessionId, 'hi');
        assert.deepEqual(err.entries.map(e => e.type), ['user', 'error']);
        assert.match(err.entries[1].text, /401/);

        assert.equal(contentFor('markdown', '**a**', {}), '**a**');
        assert.equal(contentFor('tinymce', 'a', { markdownToHtml: m => `<p>${m}</p>` }), '<p>a</p>');
        assert.throws(() => contentFor('blockeditor', 'a', {}), /block editor/);
    });
});

describe('Publii Plus: AI agent – images', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgo=';

    it('sends images as vision content in both protocols', () => {
        const msgs = [{ role: 'user', text: 'Make it look like this', images: [PNG] }];
        const chatBody = PROTOCOLS['openai-chat'].buildChat({ config: { model: 'm' }, system: 'S', messages: msgs, tools: [] }).body;
        assert.deepEqual(chatBody.messages[1].content, [{ type: 'text', text: 'Make it look like this' }, { type: 'image_url', image_url: { url: PNG } }]);

        const respBody = PROTOCOLS['openai-responses'].buildChat({ config: { model: 'm' }, system: 'S', messages: msgs, tools: [] }).body;
        assert.deepEqual(respBody.input[0].content, [{ type: 'input_text', text: 'Make it look like this' }, { type: 'input_image', image_url: PNG }]);

        const plain = PROTOCOLS['openai-chat'].buildChat({ config: { model: 'm' }, system: 'S', messages: [{ role: 'user', text: 'hi' }], tools: [] }).body;
        assert.equal(plain.messages[1].content, 'hi', 'text-only messages stay plain strings');
    });

    it('validates images and keeps them only in the last two image messages', async () => {
        const { cleanImages, withRecentImages } = require('../agent');
        assert.throws(() => cleanImages(['https://example.com/x.png']), /not a PNG/);
        assert.throws(() => cleanImages(['data:text/html;base64,PGI+']), /not a PNG/);
        assert.throws(() => cleanImages([PNG, PNG, PNG, PNG, PNG]), /up to 4/);
        assert.deepEqual(cleanImages(undefined), []);

        const history = withRecentImages([
            { role: 'user', text: 'one', images: [PNG] },
            { role: 'assistant', text: 'ok', toolCalls: [] },
            { role: 'user', text: 'two', images: [PNG, PNG] },
            { role: 'user', text: 'three', images: [PNG] }
        ]);
        assert.deepEqual(history.map(m => [m.text, (m.images || []).length]), [
            ['one\n\n[1 image(s) sent earlier – not repeated]', 0], ['ok', 0], ['two', 2], ['three', 1]
        ]);

        // through the loop: image-only message, image shown in the entry and sent to the model
        const model = scripted([{ text: 'I see a red header.' }]);
        const { agent } = makeAgent(model);
        const { sessionId } = agent.start({ site: 'blog' });
        const out = await agent.send(sessionId, '', { images: [PNG] });
        assert.deepEqual(out.entries[0].images, [PNG]);
        assert.deepEqual(model.seen[0].messages[0].images, [PNG]);
        assert.match(model.seen[0].messages[0].text, /attached image/);
        await assert.rejects(agent.send(sessionId, '', {}), /Type a message/);
    });
});

describe('Publii Plus: AI agent – content inbox and publishing', () => {
    function fakeInbox ({ canPublish = '' } = {}) {
        const calls = [];
        return {
            calls,
            status: () => ({ config: { source: 'github', repo: 'me/site', branch: 'main', folder: 'posts', enabled: true, intervalMinutes: 15, defaultStatus: 'published', autoSync: true }, canPublish, imported: 3, log: [] }),
            check: async () => ({ items: [{ path: 'a.md', action: 'create' }, { path: 'b.md', action: 'unchanged' }, { path: 'c.md', action: 'conflict', reason: 'edited in Publii' }] }),
            run: async (site, opts) => { calls.push(['run', opts]); return { created: 1, updated: 0, errors: 0, conflicts: 1, synced: opts.publish, items: [] }; },
            publish: async () => { calls.push(['publish']); return { ok: true }; }
        };
    }

    it('status is read at once; import and publish always ask, even with auto-apply, and cannot be undone', async () => {
        const inbox = fakeInbox();
        const model = scripted([
            { toolCalls: [{ id: 's', name: 'inbox_status' }] },
            messages => {
                const status = JSON.parse(messages.at(-1).output);
                assert.deepEqual(status.next.map(i => i.path), ['a.md', 'c.md']);
                assert.equal(status.autoSyncPossible, 'yes');
                return { toolCalls: [{ id: 'imp', name: 'inbox_import', args: { publish: true } }] };
            },
            { toolCalls: [{ id: 'pub', name: 'publish_site' }] },
            { text: 'Published.' }
        ]);
        const { agent } = makeAgent(model, fakeData(), inbox);
        const { sessionId } = agent.start({ site: 'blog', autoApprove: true });

        const first = await agent.send(sessionId, 'Import the inbox and publish');
        const card = first.entries.find(e => e.name === 'inbox_import');
        assert.equal(card.status, 'pending', 'auto-apply does not cover publishing');
        assert.match(card.title, /Import 1 file\(s\) from the content inbox and sync the website/);
        assert.deepEqual(card.details.slice(0, 2), ['a.md: create', 'c.md: conflict – edited in Publii']);
        assert.equal(inbox.calls.length, 0);

        const second = await agent.resolve(sessionId, { imp: { approve: true } });
        assert.deepEqual(inbox.calls, [['run', { trigger: 'agent', publish: true }]]);
        assert.equal(second.entries.find(e => e.callId === 'imp').undoable, false);
        assert.equal(second.changes.length, 0, 'nothing to undo');
        assert.equal(second.pending[0].name, 'publish_site');

        const third = await agent.resolve(sessionId, { pub: { approve: true } });
        assert.deepEqual(inbox.calls.at(-1), ['publish']);
        assert.equal(third.entries.at(-1).text, 'Published.');
    });

    it('publishing is refused with the reason when automatic sync is impossible', async () => {
        const model = scripted([{ toolCalls: [{ id: 'pub', name: 'publish_site' }] }, { text: 'ok' }]);
        const { agent } = makeAgent(model, fakeData(), fakeInbox({ canPublish: 'manual deployment' }));
        const { sessionId } = agent.start({ site: 'blog' });
        const out = await agent.send(sessionId, 'publish');
        assert.match(out.entries.find(e => e.name === 'publish_site').error, /Cannot sync automatically: manual deployment/);
    });
});

describe('Publii Plus: AI agent – site check', () => {
    it('check_site runs without asking and gives grouped problems with post ids', async () => {
        const runs = [];
        const report = {
            at: Date.UTC(2026, 10, 26),
            pages: 12,
            counts: { error: 1, warning: 2, notice: 0 },
            external: { checked: false, total: 3 },
            issues: [
                { severity: 'error', check: 'broken-link', page: 'index.html', target: '/gone/', text: 'Old post' },
                { severity: 'warning', check: 'image-alt', page: 'first/index.html', item: { type: 'post', id: 7, title: 'First' }, target: 'media/posts/7/a.jpg' },
                { severity: 'warning', check: 'image-alt', page: 'second/index.html', item: { type: 'post', id: 8, title: 'Second' }, target: 'media/posts/8/b.jpg' }
            ]
        };
        const siteCheck = {
            run: async (site, opts) => { runs.push([site, opts]); return report; },
            report: () => report
        };
        const model = scripted([
            { toolCalls: [{ id: 'c', name: 'check_site', args: { external_links: true } }] },
            messages => {
                const out = JSON.parse(messages.at(-1).output);
                assert.deepEqual(out.counts, { error: 1, warning: 2, notice: 0 });
                assert.equal(out.externalLinks, 'not checked');
                assert.equal(out.problems['image-alt'].count, 2);
                assert.deepEqual(out.problems['image-alt'].examples[0], { page: 'first/index.html', postId: 7, title: 'First', target: 'media/posts/7/a.jpg' });
                assert.deepEqual(out.problems['broken-link'].examples[0], { page: 'index.html', target: '/gone/', linkText: 'Old post' });
                return { toolCalls: [{ id: 'l', name: 'check_site', args: { last_report: true } }] };
            },
            { text: 'Two images need alt text.' }
        ]);
        const { agent } = makeAgent(model, fakeData(), null, siteCheck);
        const { sessionId } = agent.start({ site: 'blog' });
        const out = await agent.send(sessionId, 'Check the site');

        assert.deepEqual(runs, [['blog', { rerender: true, external: true }]], 'last_report does not run again');
        assert.equal(out.entries.filter(e => e.name === 'check_site').length, 2);
        assert.match(out.entries.at(-1).text, /alt text/);
    });
});

describe('Publii Plus: AI agent – alt texts', () => {
    it('write_alt_texts describes images with the chat provider, shows them for approval, applies and undoes', async () => {
        const calls = [];
        const altTexts = {
            scan: (site, opts) => {
                calls.push(['scan', opts.postIds]);
                return [
                    { postId: 7, title: 'First', images: [{ id: 'featured', kind: 'featured', src: 'cover.png', describable: true }, { id: 'c0', kind: 'content', src: '#DOMAIN_NAME#a.png', describable: true }, { id: 'c1', src: 'https://x.org/e.png', describable: false }] },
                    { postId: 8, title: 'Second', images: [{ id: 'c0', kind: 'content', src: '#DOMAIN_NAME#b.png', describable: true }] }
                ];
            },
            describe: async (site, postId, imageId, opts) => {
                calls.push(['describe', postId, imageId, opts.providerId]);
                if (postId === 8) throw new Error('model has no vision');
                return { alt: imageId === 'featured' ? 'Clinic entrance' : '', decorative: imageId !== 'featured', src: imageId === 'featured' ? 'cover.png' : '#DOMAIN_NAME#a.png' };
            },
            apply: (site, changes) => { calls.push(['apply', changes]); return { posts: 1, images: 1, skipped: 0, undoId: 'u1' }; },
            undo: id => { calls.push(['undo', id]); return { posts: 1 }; }
        };
        const model = scripted([
            { toolCalls: [{ id: 'alt', name: 'write_alt_texts', args: { post_ids: [7, 8] } }] },
            { text: 'Saved one alt text.' }
        ]);
        const { agent } = makeAgent(model, fakeData(), null, null, altTexts);
        const { sessionId } = agent.start({ site: 'blog', providerId: 'vision-model' });
        const first = await agent.send(sessionId, 'Describe the images');
        const card = first.entries.find(e => e.name === 'write_alt_texts');

        assert.equal(card.status, 'pending');
        assert.equal(card.title, 'Add alt text to 1 image(s) in 1 post(s)/page(s) (1 failed)');
        assert.deepEqual(card.details, [
            '"First" (featured image) – cover.png: Clinic entrance',
            '"First" – a.png: decorative, left empty',
            '"Second" – b.png: not described (model has no vision)'
        ]);
        assert.deepEqual(calls.filter(c => c[0] === 'describe').map(c => c[3]), ['vision-model', 'vision-model', 'vision-model']);

        await agent.resolve(sessionId, { alt: { approve: true } });
        assert.deepEqual(calls.find(c => c[0] === 'apply')[1], [{ postId: 7, alts: { featured: 'Clinic entrance' }, srcs: { featured: 'cover.png' } }]);

        agent.undo(sessionId, agent.history(sessionId).entries.find(e => e.name === 'write_alt_texts').id);
        assert.deepEqual(calls.at(-1), ['undo', 'u1']);
    });
});
