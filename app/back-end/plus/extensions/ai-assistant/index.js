/**
 * Publii Plus extension "ai-assistant": AI providers (any OpenAI-compatible http/https API)
 * and editor tasks (SEO, tags, draft, rewrite). Renderer part: app/src/plus/extensions/ai-assistant.
 */
const path = require('path');
const { createConfigStore, sanitizeProvider, PRESETS } = require('./config-store');
const { PROTOCOLS, generateStructured, chat, listModels } = require('./providers');
const { createAgent } = require('./agent');
const { TASKS, LIMITS, themeStylesRule } = require('./tasks');
const { isInsecureRemote } = require('./http');

function markdownToHtml (markdown) {
    const { marked } = require('marked');
    return marked.parse(String(markdown || ''), { mangle: false, headerIds: false });
}

const THEME_STYLE_TASKS = ['draft', 'post', 'rewrite'];

/** Append the website owner's instructions; they refine but do not replace the task rules. */
function withInstructions (system, instructions) {
    if (!instructions) return system;

    const parts = [];

    if (instructions.global) parts.push(instructions.global);
    if (instructions.site) parts.push(instructions.site);
    if (!parts.length) return system;

    return system + '\n\nInstructions from the website owner (follow them unless they contradict the required JSON format or length limits):\n' + parts.join('\n\n');
}

function createService ({ store, fetchImpl, createSlug = null }) {
    const running = new Map();

    /** Provider config for test/models: a saved provider, or an unsaved draft from the form. */
    async function resolveDraft (draft) {
        if (draft && draft.id && !draft.baseUrl) {
            return store.resolve(draft.id);
        }

        const provider = sanitizeProvider({ ...draft, model: draft && draft.model ? draft.model : '-' });
        let apiKey = draft && typeof draft.apiKey === 'string' && draft.apiKey.trim() ? draft.apiKey.trim() : '';

        if (!apiKey && draft && draft.id) {
            apiKey = await store.secrets.get(draft.id);
        }

        return { provider: { ...provider, model: draft && draft.model ? provider.model : '' }, apiKey };
    }

    async function runTask ({ task, input = {}, providerId, requestId, provider: inlineProvider }) {
        const definition = TASKS[task];

        if (!definition) throw new Error(`Unknown task "${task}".`);

        const { provider, apiKey } = inlineProvider || await store.resolve(providerId);
        const controller = new AbortController();

        if (requestId) running.set(requestId, controller);

        const started = Date.now();

        try {
            const built = definition.build(input);
            const instructions = store.getInstructions ? store.getInstructions(input.siteName) : null;
            let system = built.system;

            // Theme styles matter only where the AI writes content
            if (THEME_STYLE_TASKS.includes(task) && (!instructions || instructions.useThemeStyles !== false)) {
                const rule = themeStylesRule(input.themeStyles);

                if (rule) system += '\n\n' + rule;
            }

            if (task !== 'ping') system = withInstructions(system, instructions);
            const user = built.user;
            const result = await generateStructured({
                config: provider,
                apiKey,
                system,
                user,
                schema: definition.schema,
                schemaName: definition.schemaName,
                signal: controller.signal,
                fetchImpl
            });

            return {
                result: definition.finish(result.data, input, { createSlug, markdownToHtml }),
                usage: result.usage,
                model: result.model,
                provider: provider.name,
                ms: Date.now() - started
            };
        } finally {
            if (requestId) running.delete(requestId);
        }
    }

    return {
        presets () {
            return {
                presets: PRESETS,
                protocols: Object.entries(PROTOCOLS).map(([value, p]) => ({ value, label: p.label })),
                limits: LIMITS
            };
        },
        async list () {
            const data = await store.listPublic();
            data.providers = data.providers.map(p => ({ ...p, insecure: isInsecureRemote(p.baseUrl) && !!p.authHeader }));
            return data;
        },
        async save (draft) {
            return store.upsertProvider(draft);
        },
        async remove (id) {
            await store.removeProvider(id);
            return true;
        },
        setDefault (id) {
            store.setDefault(id);
            return true;
        },
        getInstructions (siteName) {
            return store.getInstructions(siteName);
        },
        saveInstructions (data) {
            return store.saveInstructions(data || {});
        },
        async models (draft) {
            const { provider, apiKey } = await resolveDraft(draft);
            return listModels({ config: provider, apiKey, fetchImpl });
        },
        async test (draft) {
            const resolved = await resolveDraft(draft);

            if (!resolved.provider.model) throw new Error('Enter a model name.');

            const out = await runTask({ task: 'ping', provider: resolved });
            return { ok: out.result.ok, model: out.model, ms: out.ms };
        },
        run: runTask,
        cancel (requestId) {
            const controller = running.get(requestId);

            if (controller) controller.abort();
            return !!controller;
        }
    };
}

module.exports = {
    id: 'ai-assistant',
    withInstructions,
    name: 'AI Assistant',
    createService,

    register (ctx) {
        let passwordStorage = null;
        let safeStorage = null;
        let createSlug = null;

        try { passwordStorage = require('../../../helpers/password-storage.js'); } catch (e) { /* tests */ }
        if (process.versions.electron) {
            try { safeStorage = require('electron').safeStorage; } catch (e) { /* not available */ }
        }
        try { createSlug = require('../../../helpers/slug.js'); } catch (e) { /* optional */ }

        const store = createConfigStore({
            configDir: path.join(ctx.paths.appDir, 'config'),
            passwordStorage,
            safeStorage
        });
        const service = createService({ store, createSlug });

        ctx.handle('presets', () => service.presets());
        ctx.handle('providers:list', () => service.list());
        ctx.handle('providers:save', (event, draft) => service.save(draft));
        ctx.handle('providers:remove', (event, id) => service.remove(id));
        ctx.handle('providers:set-default', (event, id) => service.setDefault(id));
        ctx.handle('providers:models', (event, draft) => service.models(draft));
        ctx.handle('providers:test', (event, draft) => service.test(draft));
        ctx.handle('instructions:get', (event, siteName) => service.getInstructions(siteName));
        ctx.handle('instructions:save', (event, data) => service.saveInstructions(data));
        ctx.handle('run', (event, request) => service.run(request));

        // AI agent (chat with tools over the current website)
        const { createPubliiData } = require('./agent/publii-data');
        const themeEditor = require('../theme-editor');
        const { createUnifiedDiff } = require('../../lib/unified-diff');
        const themes = themeEditor.createService({ getSitesDir: () => ctx.appInstance && ctx.appInstance.sitesDir });
        const data = createPubliiData({ app: ctx.appInstance });
        const agent = createAgent({
            resolveProvider: id => store.resolve(id),
            chat: options => chat(options),
            getInstructions: site => store.getInstructions(site),
            withInstructions,
            makeContext: site => agentContext(site)
        });

        function agentContext (site) {
            if (!/^[a-zA-Z0-9_.-]+$/.test(String(site || '')) || String(site).startsWith('.')) throw new Error('Invalid website.');

            return {
                site,
                data,
                theme: themes,
                markdownToHtml,
                createDiff: (oldText, newText, name) => createUnifiedDiff(oldText, newText, { oldName: 'a/' + name, newName: 'b/' + name })
            };
        }

        ctx.handle('agent:start', (event, options) => agent.start(options || {}));
        ctx.handle('agent:send', (event, sessionId, text, options) => agent.send(sessionId, text, options || {}));
        ctx.handle('agent:resolve', (event, sessionId, decisions) => agent.resolve(sessionId, decisions || {}));
        ctx.handle('agent:undo', (event, sessionId, changeId) => agent.undo(sessionId, changeId));
        ctx.handle('agent:cancel', (event, sessionId) => agent.cancel(sessionId));
        ctx.handle('agent:history', (event, sessionId) => agent.history(sessionId));
        ctx.handle('agent:close', (event, sessionId) => agent.close(sessionId));
        ctx.handle('agent:store-data', (event, site) => data.storeData(agentContext(site).site));
        ctx.handle('cancel', (event, requestId) => service.cancel(requestId));
    }
};
