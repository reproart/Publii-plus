/**
 * AI Assistant settings: Documents/Publii/config/publii-plus-ai.json (no secrets inside).
 * API keys: system keychain (service "publii-plus-ai", account = provider id); when the keychain
 * is unavailable, Electron safeStorage-encrypted values in publii-plus-ai.secrets.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROTOCOLS } = require('./providers');
const { createSecretStore: createGenericSecretStore } = require('../../lib/secret-store');

function createSecretStore (options) {
    return createGenericSecretStore({ ...options, service: KEYCHAIN_SERVICE });
}

const KEYCHAIN_SERVICE = 'publii-plus-ai';

const PRESETS = [
    { key: 'openai', name: 'OpenAI', type: 'openai-responses', baseUrl: 'https://api.openai.com/v1', structuredOutput: 'json_schema', authHeader: 'Authorization', authPrefix: 'Bearer ' },
    { key: 'openrouter', name: 'OpenRouter', type: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', structuredOutput: 'json_schema', authHeader: 'Authorization', authPrefix: 'Bearer ', headers: { 'X-Title': 'Publii Plus' } },
    { key: 'ollama', name: 'Ollama (local)', type: 'openai-chat', baseUrl: 'http://localhost:11434/v1', structuredOutput: 'json_schema', authHeader: '', authPrefix: '' },
    { key: 'lmstudio', name: 'LM Studio (local)', type: 'openai-chat', baseUrl: 'http://localhost:1234/v1', structuredOutput: 'json_schema', authHeader: '', authPrefix: '' },
    { key: 'custom', name: 'Custom (OpenAI-compatible)', type: 'openai-chat', baseUrl: '', structuredOutput: 'json_schema', authHeader: 'Authorization', authPrefix: 'Bearer ' }
];

const DEFAULT_CONFIG = { version: 1, defaultProviderId: '', providers: [], instructions: '', siteInstructions: {}, useThemeStyles: true };

const MAX_INSTRUCTIONS = 8000;

function cleanInstructions (text) {
    return String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_INSTRUCTIONS);
}

function toNumberOrNull (value, min, max) {
    if (value === '' || value === null || value === undefined) return null;

    const n = Number(value);

    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
}

/** Validate and normalize a provider coming from the UI. Throws with a readable message. */
function sanitizeProvider (input, existingIds = []) {
    const name = String(input.name || '').trim().slice(0, 80);
    const type = String(input.type || '');
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
    const model = String(input.model || '').trim().slice(0, 200);

    if (!name) throw new Error('Enter a provider name.');
    if (!PROTOCOLS[type]) throw new Error('Choose an API type.');

    let url;

    try {
        url = new URL(baseUrl);
    } catch (e) {
        throw new Error('Enter a valid base URL, e.g. https://api.openai.com/v1');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The base URL must start with http:// or https://');
    if (!model) throw new Error('Enter a model name.');

    const headers = {};

    for (const [key, value] of Object.entries(input.headers || {})) {
        const headerName = String(key).trim();

        if (!/^[A-Za-z0-9-]+$/.test(headerName)) throw new Error(`Invalid header name "${headerName}".`);
        headers[headerName] = String(value).replace(/[\r\n]/g, ' ').trim();
    }

    const authHeader = input.authHeader === undefined ? 'Authorization' : String(input.authHeader).trim();

    if (authHeader && !/^[A-Za-z0-9-]+$/.test(authHeader)) throw new Error('Invalid auth header name.');

    let id = String(input.id || '').trim();

    if (!/^[a-z0-9-]{1,64}$/.test(id) || (!input.id && existingIds.includes(id))) {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'provider';
        id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    }

    return {
        id,
        name,
        type,
        baseUrl,
        model,
        authHeader,
        authPrefix: input.authPrefix === undefined ? 'Bearer ' : String(input.authPrefix).replace(/[\r\n]/g, ''),
        headers,
        structuredOutput: ['json_schema', 'json_object', 'prompt'].includes(input.structuredOutput) ? input.structuredOutput : 'json_schema',
        temperature: toNumberOrNull(input.temperature, 0, 2),
        maxOutputTokens: toNumberOrNull(input.maxOutputTokens, 16, 200000),
        timeoutMs: (toNumberOrNull(input.timeoutSeconds, 5, 900) || 120) * 1000
    };
}

function createConfigStore ({ configDir, passwordStorage, safeStorage }) {
    const file = path.join(configDir, 'publii-plus-ai.json');
    const secrets = createSecretStore({ passwordStorage, safeStorage, secretsFile: path.join(configDir, 'publii-plus-ai.secrets.json') });

    const load = () => {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return { ...DEFAULT_CONFIG, ...data, providers: Array.isArray(data.providers) ? data.providers : [] };
        } catch (e) {
            return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        }
    };

    const save = config => {
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(config, null, 2));
    };

    return {
        file,
        secrets,
        load,
        save,

        /** Providers as shown to the renderer: never includes the key. */
        async listPublic () {
            const config = load();
            const providers = [];

            for (const p of config.providers) {
                providers.push({ ...p, hasApiKey: !!(await secrets.get(p.id)) });
            }

            return { defaultProviderId: config.defaultProviderId, providers };
        },

        async upsertProvider (input) {
            const config = load();
            const provider = sanitizeProvider(input, config.providers.map(p => p.id));
            const index = config.providers.findIndex(p => p.id === provider.id);

            if (index >= 0) config.providers[index] = provider;
            else config.providers.push(provider);

            if (!config.defaultProviderId || !config.providers.some(p => p.id === config.defaultProviderId)) {
                config.defaultProviderId = provider.id;
            }

            // apiKey: undefined = keep, '' = remove, string = replace
            if (typeof input.apiKey === 'string') {
                if (input.apiKey.trim()) await secrets.set(provider.id, input.apiKey.trim());
                else await secrets.remove(provider.id);
            }

            save(config);
            return provider;
        },

        async removeProvider (id) {
            const config = load();
            config.providers = config.providers.filter(p => p.id !== id);

            if (config.defaultProviderId === id) config.defaultProviderId = config.providers[0] ? config.providers[0].id : '';

            save(config);
            await secrets.remove(id);
        },

        /** Custom instructions added to every request: global and per website (key = site folder name). */
        getInstructions (siteName) {
            const config = load();
            const site = siteName && config.siteInstructions ? config.siteInstructions[siteName] || '' : '';
            return { global: config.instructions || '', site, useThemeStyles: config.useThemeStyles !== false };
        },

        saveInstructions ({ global, siteName, site, useThemeStyles }) {
            const config = load();
            config.instructions = cleanInstructions(global);

            if (typeof useThemeStyles === 'boolean') config.useThemeStyles = useThemeStyles;
            config.siteInstructions = config.siteInstructions && typeof config.siteInstructions === 'object' ? config.siteInstructions : {};

            if (siteName && /^[^\/\\]{1,200}$/.test(siteName)) {
                const value = cleanInstructions(site);

                if (value) config.siteInstructions[siteName] = value;
                else delete config.siteInstructions[siteName];
            }

            save(config);
            return this.getInstructions(siteName);
        },

        setDefault (id) {
            const config = load();

            if (!config.providers.some(p => p.id === id)) throw new Error('Unknown provider.');

            config.defaultProviderId = id;
            save(config);
        },

        /** Provider config + key for a request (main process only). */
        async resolve (id) {
            const config = load();
            const provider = config.providers.find(p => p.id === (id || config.defaultProviderId)) || config.providers[0];

            if (!provider) throw new Error('No AI provider configured. Add one in Settings → Publii Plus: AI providers.');

            return { provider, apiKey: await secrets.get(provider.id) };
        }
    };
}

module.exports = { createConfigStore, createSecretStore, sanitizeProvider, PRESETS, KEYCHAIN_SERVICE };
