const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { parseJsonFromText, validate, toStrictSchema } = require('../json-utils');
const { generateStructured, listModels, authHeaders } = require('../providers');
const { createConfigStore, sanitizeProvider } = require('../config-store');
const { isInsecureRemote, describeError } = require('../http');
const { TASKS, fitLength } = require('../tasks');
const extension = require('../index');

/** Fake OpenAI / OpenAI-compatible server. `reply(req, body)` returns { status, json } or a JSON object. */
function startServer (reply) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', async () => {
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            const out = await reply(req, body, requests.length);

            if (out === 'hang') return;

            const wrapped = out && typeof out.status === 'number' && 'json' in out;
            const status = wrapped ? out.status : 200;
            const json = wrapped ? out.json : out;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(typeof json === 'string' ? json : JSON.stringify(json));
        });
    });

    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(r => server.close(r)) });
    }));
}

const responsesReply = (text, extra = {}) => ({ model: 'm-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
const chatReply = (content, extra = {}) => ({ model: 'm-2', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 7, completion_tokens: 3 }, ...extra });

const SEO = TASKS.seo;

function cfg (url, over = {}) {
    return { type: 'openai-chat', baseUrl: url, model: 'test-model', structuredOutput: 'json_schema', ...over };
}

describe('Publii Plus AI: json utils', () => {
    it('extracts JSON from fences and surrounding text', () => {
        assert.deepEqual(parseJsonFromText('```json\n{"a":1}\n```'), { a: 1 });
        assert.deepEqual(parseJsonFromText('Sure! {"a":"}{"} – done'), { a: '}{' });
        assert.throws(() => parseJsonFromText('no json here'), /did not return JSON/);
    });

    it('validates types/required and makes strict schemas', () => {
        assert.deepEqual(validate({ metaTitle: 'x', metaDescription: 'y', slug: 'z' }, SEO.schema), []);
        assert.match(validate({ metaTitle: 1 }, SEO.schema).join(), /metaDescription is required.*|metaTitle must be a string/);

        const strict = toStrictSchema(TASKS.tags.schema);
        assert.equal(strict.additionalProperties, false);
        assert.equal(strict.properties.tags.maxItems, undefined);
        assert.deepEqual(strict.properties.tags.items.required, ['name']);
    });
});

describe('Publii Plus AI: providers', () => {
    it('OpenAI Responses: json_schema format, auth header, usage', async () => {
        const srv = await startServer(() => responsesReply('{"metaTitle":"T","metaDescription":"D","slug":"s"}'));

        try {
            const out = await generateStructured({ config: cfg(srv.url, { type: 'openai-responses', temperature: 0.2 }), apiKey: 'sk-test', system: 'S', user: 'U', schema: SEO.schema, schemaName: 'seo' });
            const req = srv.requests[0];

            assert.equal(req.url, '/v1/responses');
            assert.equal(req.headers.authorization, 'Bearer sk-test');
            assert.equal(req.body.instructions, 'S');
            assert.equal(req.body.input, 'U');
            assert.equal(req.body.temperature, 0.2);
            assert.equal(req.body.text.format.type, 'json_schema');
            assert.equal(req.body.text.format.strict, true);
            assert.deepEqual(out.data, { metaTitle: 'T', metaDescription: 'D', slug: 's' });
            assert.deepEqual(out.usage, { input: 10, output: 5 });
        } finally {
            await srv.close();
        }
    });

    it('Chat Completions: falls back to prompt-only JSON when response_format is rejected', async () => {
        const srv = await startServer((req, body) => body.response_format
            ? { status: 400, json: { error: { message: "Unsupported parameter: 'response_format'" } } }
            : chatReply('Here you go:\n```json\n{"metaTitle":"T","metaDescription":"D","slug":"s"}\n```'));

        try {
            const out = await generateStructured({ config: cfg(srv.url), apiKey: '', system: 'S', user: 'U', schema: SEO.schema });

            assert.equal(out.mode, 'prompt');
            assert.equal(srv.requests.length, 2);
            assert.equal(srv.requests[1].headers.authorization, undefined, 'no key -> no auth header');
            assert.match(srv.requests[1].body.messages[0].content, /JSON Schema/);
            assert.equal(out.data.slug, 's');
        } finally {
            await srv.close();
        }
    });

    it('repairs an invalid reply once, then fails clearly', async () => {
        const srv = await startServer((req, body, n) => chatReply(n === 1 ? '{"metaTitle":"T"}' : '{"metaTitle":"T","metaDescription":"D","slug":"s"}'));

        try {
            const out = await generateStructured({ config: cfg(srv.url, { structuredOutput: 'prompt' }), system: 'S', user: 'U', schema: SEO.schema });
            assert.equal(srv.requests.length, 2);
            assert.match(srv.requests[1].body.messages[1].content, /is invalid: \$\.metaDescription is required/);
            assert.deepEqual(out.usage, { input: 14, output: 6 });
        } finally {
            await srv.close();
        }

        const bad = await startServer(() => chatReply('nope'));

        try {
            await assert.rejects(generateStructured({ config: cfg(bad.url), system: 'S', user: 'U', schema: SEO.schema }), /did not return JSON/);
        } finally {
            await bad.close();
        }
    });

    it('reports HTTP errors, truncation, timeouts and cancellation', async () => {
        const srv = await startServer((req, body) => {
            if (body.model === 'unauthorized') return { status: 401, json: { error: { message: 'Incorrect API key provided' } } };
            if (body.model === 'cut') return chatReply('{"a"', { choices: [{ finish_reason: 'length', message: { content: '{"a"' } }] });
            return 'hang';
        });

        try {
            await assert.rejects(generateStructured({ config: cfg(srv.url, { model: 'unauthorized' }), system: 'S', user: 'U', schema: SEO.schema }), /HTTP 401: Incorrect API key provided Check the API key/);
            await assert.rejects(generateStructured({ config: cfg(srv.url, { model: 'cut' }), system: 'S', user: 'U', schema: SEO.schema }), /cut off/);
            await assert.rejects(generateStructured({ config: cfg(srv.url, { model: 'slow', timeoutMs: 200 }), system: 'S', user: 'U', schema: SEO.schema }), /did not answer within/);

            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);
            await assert.rejects(generateStructured({ config: cfg(srv.url, { model: 'slow' }), system: 'S', user: 'U', schema: SEO.schema, signal: controller.signal }), /Cancelled/);
        } finally {
            srv.server.closeAllConnections();
            await srv.close();
        }
    });

    it('lists models and builds custom auth headers', async () => {
        const srv = await startServer(() => ({ data: [{ id: 'b-model' }, { id: 'a-model' }] }));

        try {
            assert.deepEqual(await listModels({ config: cfg(srv.url, { authHeader: 'api-key', authPrefix: '' }), apiKey: 'k' }), ['a-model', 'b-model']);
            assert.equal(srv.requests[0].method, 'GET');
            assert.equal(srv.requests[0].headers['api-key'], 'k');
        } finally {
            await srv.close();
        }

        assert.deepEqual(authHeaders({ headers: { 'X-Title': 'P', 'bad header': 'x' } }, 'k'), { 'X-Title': 'P', Authorization: 'Bearer k' });
        assert.equal(describeError(429, 'oops'), 'HTTP 429: oops Rate limit or quota exceeded – try again later.');
    });

    it('rejects non-http URLs and flags insecure remote http', async () => {
        await assert.rejects(generateStructured({ config: cfg('file:///etc'), system: 'S', user: 'U', schema: SEO.schema }), /Only http/);
        assert.equal(isInsecureRemote('http://localhost:11434/v1'), false);
        assert.equal(isInsecureRemote('http://192.168.1.5:8000/v1'), false);
        assert.equal(isInsecureRemote('http://ai.example.com/v1'), true);
        assert.equal(isInsecureRemote('https://ai.example.com/v1'), false);
    });
});

describe('Publii Plus AI: config store', () => {
    function makeStore ({ keychainWorks = true } = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-ai-'));
        const keychain = {};
        const passwordStorage = {
            async getPassword (s, a) { if (!keychainWorks) throw new Error('no keychain'); return keychain[s + '/' + a] || null; },
            async setPassword (s, a, v) { if (!keychainWorks) throw new Error('no keychain'); keychain[s + '/' + a] = v; },
            async deletePassword (s, a) { delete keychain[s + '/' + a]; }
        };
        const safeStorage = {
            isEncryptionAvailable: () => true,
            encryptString: v => Buffer.from('enc:' + v),
            decryptString: b => b.toString().replace(/^enc:/, '')
        };
        return { dir, keychain, store: createConfigStore({ configDir: dir, passwordStorage, safeStorage }) };
    }

    it('validates providers', () => {
        assert.throws(() => sanitizeProvider({ name: 'X', type: 'openai-chat', baseUrl: 'ftp://x', model: 'm' }), /http:\/\/ or https:\/\//);
        assert.throws(() => sanitizeProvider({ name: 'X', type: 'nope', baseUrl: 'https://x', model: 'm' }), /API type/);
        assert.throws(() => sanitizeProvider({ name: 'X', type: 'openai-chat', baseUrl: 'https://x', model: '' }), /model/);

        const p = sanitizeProvider({ name: 'My LLM', type: 'openai-chat', baseUrl: 'https://x.org/v1/', model: 'm', temperature: '5', timeoutSeconds: '30' });
        assert.match(p.id, /^my-llm-[0-9a-f]{6}$/);
        assert.equal(p.baseUrl, 'https://x.org/v1');
        assert.equal(p.temperature, 2);
        assert.equal(p.timeoutMs, 30000);
    });

    it('keeps keys out of the config file and the renderer', async () => {
        const { dir, keychain, store } = makeStore();
        const saved = await store.upsertProvider({ name: 'OpenAI', type: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-secret' });

        assert.doesNotMatch(fs.readFileSync(path.join(dir, 'publii-plus-ai.json'), 'utf8'), /sk-secret/);
        assert.equal(keychain['publii-plus-ai/' + saved.id], 'sk-secret');

        const listed = await store.listPublic();
        assert.equal(listed.defaultProviderId, saved.id);
        assert.equal(listed.providers[0].hasApiKey, true);
        assert.doesNotMatch(JSON.stringify(listed), /sk-secret/);

        await store.upsertProvider({ ...saved, model: 'm2' });
        assert.equal((await store.resolve()).apiKey, 'sk-secret', 'undefined apiKey keeps the stored key');

        await store.upsertProvider({ ...saved, apiKey: '' });
        assert.equal((await store.resolve()).apiKey, '', 'empty apiKey removes it');

        await store.removeProvider(saved.id);
        await assert.rejects(store.resolve(), /No AI provider configured/);
    });

    it('falls back to encrypted file when the keychain is unavailable', async () => {
        const { dir, store } = makeStore({ keychainWorks: false });
        const saved = await store.upsertProvider({ name: 'A', type: 'openai-chat', baseUrl: 'http://localhost:1/v1', model: 'm', apiKey: 'k1' });

        assert.match(fs.readFileSync(path.join(dir, 'publii-plus-ai.secrets.json'), 'utf8'), new RegExp(Buffer.from('enc:k1').toString('base64')));
        assert.equal((await store.resolve(saved.id)).apiKey, 'k1');
    });
});

describe('Publii Plus AI: tasks and service', () => {
    it('SEO: enforces limits and normalizes the slug', () => {
        const out = SEO.finish({ metaTitle: 'A'.repeat(50) + ' ' + 'B'.repeat(40), metaDescription: 'word '.repeat(60), slug: 'Привет мир!' }, {}, { createSlug: require('../../../../helpers/slug.js') });

        assert.ok(out.metaTitle.length <= 70);
        assert.ok(out.metaDescription.length <= 160);
        assert.equal(out.slug, 'privet-mir');
        assert.equal(fitLength('one two three', 9), 'one two');
    });

    it('tags: prefers existing spelling, dedupes, marks new, keeps main tag valid', () => {
        const out = TASKS.tags.finish(
            { tags: [{ name: 'publii' }, { name: '#Static Sites' }, { name: 'PUBLII' }, { name: 'AI' }], mainTag: 'ghost' },
            { existingTags: ['Publii', 'CSS'] }
        );

        assert.deepEqual(out.tags, [{ name: 'Publii', isNew: false }, { name: 'Static Sites', isNew: true }, { name: 'AI', isNew: true }]);
        assert.equal(out.mainTag, 'Publii');
    });

    it('draft: converts Markdown to HTML and drops a repeated H1', async () => {
        const srv = await startServer(() => chatReply(JSON.stringify({ title: 'Hello', markdown: '# Hello\n\n## Part\n\n| a | b |\n|---|---|\n| 1 | 2 |' })));
        const store = { resolve: async () => ({ provider: cfg(srv.url, { name: 'Local' }), apiKey: '' }) };

        try {
            const service = extension.createService({ store });
            const out = await service.run({ task: 'draft', input: { brief: 'about tables', length: 'short' } });

            assert.equal(out.result.title, 'Hello');
            assert.equal(out.result.markdown.startsWith('## Part'), true);
            assert.match(out.result.html, /<h2>Part<\/h2>/);
            assert.match(out.result.html, /<table>/);
            assert.equal(out.provider, 'Local');
            assert.match(srv.requests[0].body.messages[0].content, /about 300 words/);
        } finally {
            await srv.close();
        }
    });

    it('extension registers its IPC channels', () => {
        const channels = [];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-ai-reg-'));
        extension.register({ paths: { appDir: dir }, handle: name => channels.push(name) });

        assert.deepEqual(channels.sort(), ['cancel', 'presets', 'providers:list', 'providers:models', 'providers:remove', 'providers:save', 'providers:set-default', 'providers:test', 'run'].sort());
    });
});
