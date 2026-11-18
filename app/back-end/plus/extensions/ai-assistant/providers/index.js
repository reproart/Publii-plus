/**
 * AI provider layer.
 *
 * A provider config (stored in Documents/Publii/config/publii-plus-ai.json, without the key):
 * {
 *   id, name,
 *   type: 'openai-responses' | 'openai-chat',   // protocol, see PROTOCOLS
 *   baseUrl: 'https://api.openai.com/v1',       // any http(s) URL
 *   model: '...',
 *   authHeader: 'Authorization',                // header carrying the key ('' = no auth)
 *   authPrefix: 'Bearer ',                       // prefix before the key
 *   headers: { 'X-Title': 'Publii Plus' },       // extra non-secret headers
 *   structuredOutput: 'json_schema' | 'json_object' | 'prompt',
 *   temperature: null | number,
 *   maxOutputTokens: null | number,
 *   timeoutMs: 120000
 * }
 * The API key comes from the secret store and is passed separately.
 *
 * Every protocol implements:
 *   buildRequest({ config, system, user, schema, schemaName, mode }) -> { path, body }
 *   parseResponse(json) -> { text, usage: { input, output } }
 */
const { requestJson, ProviderHttpError } = require('../http');
const { parseJsonFromText, validate, toStrictSchema } = require('../json-utils');

function schemaInstruction (schema) {
    return '\n\nReply with a single JSON object only (no markdown, no comments) that matches this JSON Schema:\n' +
        JSON.stringify(schema);
}

const PROTOCOLS = {
    'openai-responses': {
        label: 'OpenAI Responses API',
        buildRequest ({ config, system, user, schema, schemaName, mode }) {
            const body = { model: config.model, instructions: system, input: user };

            if (schema && mode === 'json_schema') {
                body.text = { format: { type: 'json_schema', name: schemaName, schema: toStrictSchema(schema), strict: true } };
            } else if (schema) {
                body.instructions += schemaInstruction(schema);

                if (mode === 'json_object') body.text = { format: { type: 'json_object' } };
            }

            if (typeof config.temperature === 'number') body.temperature = config.temperature;
            if (config.maxOutputTokens) body.max_output_tokens = config.maxOutputTokens;

            return { path: '/responses', body };
        },
        parseResponse (json) {
            const parts = [];

            for (const item of json.output || []) {
                if (item.type !== 'message') continue;

                for (const content of item.content || []) {
                    if (content.type === 'output_text') parts.push(content.text);
                    if (content.type === 'refusal') throw new ProviderHttpError('The model refused: ' + content.refusal);
                }
            }

            if (!parts.length && typeof json.output_text === 'string') parts.push(json.output_text);

            if (json.status === 'incomplete') {
                const reason = json.incomplete_details && json.incomplete_details.reason;
                throw new ProviderHttpError(reason === 'max_output_tokens'
                    ? 'The answer was cut off (max output tokens). Increase the limit in the provider settings.'
                    : 'The answer is incomplete' + (reason ? ` (${reason})` : '') + '.');
            }

            const usage = json.usage || {};
            return { text: parts.join(''), usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 }, model: json.model };
        },
        /** Agent turn with tools. messages: neutral history, see toNeutral() in chat(). */
        buildChat ({ config, system, messages, tools }) {
            const input = [];

            for (const m of messages) {
                if (m.role === 'user') input.push({ role: 'user', content: m.text });
                else if (m.role === 'assistant') {
                    // replay the provider's own output items (keeps reasoning items with tool calls)
                    if (m.raw && m.raw.protocol === 'openai-responses') input.push(...m.raw.items);
                    else {
                        if (m.text) input.push({ role: 'assistant', content: m.text });
                        for (const c of m.toolCalls || []) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
                    }
                } else if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.id, output: m.output });
            }

            const body = { model: config.model, instructions: system, input };

            if (tools && tools.length) body.tools = tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
            if (typeof config.temperature === 'number') body.temperature = config.temperature;
            if (config.maxOutputTokens) body.max_output_tokens = config.maxOutputTokens;

            return { path: '/responses', body };
        },
        parseChat (json) {
            const texts = [];
            const toolCalls = [];
            const items = [];

            for (const item of json.output || []) {
                if (item.type === 'message') {
                    for (const content of item.content || []) {
                        if (content.type === 'output_text') texts.push(content.text);
                        if (content.type === 'refusal') texts.push('The model refused: ' + content.refusal);
                    }
                    items.push({ role: 'assistant', content: (item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') });
                } else if (item.type === 'function_call') {
                    toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments || '{}' });
                    items.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments || '{}' });
                } else if (item.type === 'reasoning') {
                    items.push(item);
                }
            }

            if (json.status === 'incomplete' && !toolCalls.length) {
                const reason = json.incomplete_details && json.incomplete_details.reason;
                texts.push(reason === 'max_output_tokens' ? '\n\n(The answer was cut off: max output tokens.)' : '\n\n(The answer is incomplete.)');
            }

            const usage = json.usage || {};
            return {
                text: texts.join(''),
                toolCalls,
                raw: { protocol: 'openai-responses', items },
                usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 },
                model: json.model
            };
        }
    },

    'openai-chat': {
        label: 'OpenAI-compatible Chat Completions',
        buildRequest ({ config, system, user, schema, schemaName, mode }) {
            let systemText = system;
            const body = { model: config.model };

            if (schema && mode === 'json_schema') {
                body.response_format = { type: 'json_schema', json_schema: { name: schemaName, schema: toStrictSchema(schema), strict: true } };
            } else if (schema) {
                systemText += schemaInstruction(schema);

                if (mode === 'json_object') body.response_format = { type: 'json_object' };
            }

            body.messages = [{ role: 'system', content: systemText }, { role: 'user', content: user }];

            if (typeof config.temperature === 'number') body.temperature = config.temperature;
            if (config.maxOutputTokens) body.max_tokens = config.maxOutputTokens;

            return { path: '/chat/completions', body };
        },
        parseResponse (json) {
            const choice = (json.choices || [])[0];

            if (!choice || !choice.message) {
                throw new ProviderHttpError('The provider returned no answer.');
            }

            if (choice.message.refusal) throw new ProviderHttpError('The model refused: ' + choice.message.refusal);

            if (choice.finish_reason === 'length') {
                throw new ProviderHttpError('The answer was cut off (max tokens). Increase the limit in the provider settings.');
            }

            let content = choice.message.content;

            if (Array.isArray(content)) content = content.map(c => c.text || '').join('');

            const usage = json.usage || {};
            return { text: String(content || ''), usage: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 }, model: json.model };
        },
        buildChat ({ config, system, messages, tools }) {
            const out = [{ role: 'system', content: system }];

            for (const m of messages) {
                if (m.role === 'user') out.push({ role: 'user', content: m.text });
                else if (m.role === 'assistant') {
                    const msg = { role: 'assistant', content: m.text || null };

                    if (m.toolCalls && m.toolCalls.length) {
                        msg.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
                    }

                    out.push(msg);
                } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.id, content: m.output });
            }

            const body = { model: config.model, messages: out };

            if (tools && tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
            if (typeof config.temperature === 'number') body.temperature = config.temperature;
            if (config.maxOutputTokens) body.max_tokens = config.maxOutputTokens;

            return { path: '/chat/completions', body };
        },
        parseChat (json) {
            const choice = (json.choices || [])[0];

            if (!choice || !choice.message) throw new ProviderHttpError('The provider returned no answer.');

            let content = choice.message.content;

            if (Array.isArray(content)) content = content.map(c => c.text || '').join('');

            let text = String(content || '');

            if (choice.message.refusal) text += 'The model refused: ' + choice.message.refusal;

            const toolCalls = (choice.message.tool_calls || [])
                .filter(c => c && c.function && c.function.name)
                .map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) }));

            if (choice.finish_reason === 'length' && !toolCalls.length) text += '\n\n(The answer was cut off: max tokens.)';

            const usage = json.usage || {};
            return { text, toolCalls, usage: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 }, model: json.model };
        }
    }
};

function normalizeBaseUrl (url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function authHeaders (config, apiKey) {
    const headers = {};

    for (const [name, value] of Object.entries(config.headers || {})) {
        if (/^[A-Za-z0-9-]+$/.test(name)) headers[name] = String(value);
    }

    const headerName = config.authHeader === undefined ? 'Authorization' : config.authHeader;

    if (apiKey && headerName) {
        const prefix = config.authPrefix === undefined ? 'Bearer ' : config.authPrefix;
        headers[headerName] = prefix + apiKey;
    }

    return headers;
}

/** Response-format errors from servers that do not support json_schema. */
function isResponseFormatError (error) {
    return error instanceof ProviderHttpError && (error.status === 400 || error.status === 422) &&
        /response_format|json_schema|text\.format|structured|schema/i.test(error.message + ' ' + error.body);
}

/**
 * Run one structured request: returns { data, text, usage, model, mode }.
 * - falls back from json_schema to prompt-only JSON when the server rejects response_format
 * - one repair round-trip when the JSON is missing or does not match the schema
 */
async function generateStructured ({ config, apiKey, system, user, schema, schemaName = 'result', signal, fetchImpl }) {
    const protocol = PROTOCOLS[config.type];

    if (!protocol) throw new Error(`Unknown provider type "${config.type}".`);
    if (!config.model) throw new Error('No model is set for this provider.');

    let mode = config.structuredOutput || 'json_schema';

    const call = async (userText) => {
        const { path, body } = protocol.buildRequest({ config, system, user: userText, schema, schemaName, mode });
        const json = await requestJson({
            url: normalizeBaseUrl(config.baseUrl) + path,
            headers: authHeaders(config, apiKey),
            body,
            timeoutMs: config.timeoutMs || 120000,
            signal,
            fetchImpl
        });

        return protocol.parseResponse(json);
    };

    let result;

    try {
        result = await call(user);
    } catch (error) {
        if (mode === 'json_schema' && isResponseFormatError(error)) {
            mode = 'prompt';
            result = await call(user);
        } else {
            throw error;
        }
    }

    const usage = { ...result.usage };
    let data;
    let problems;

    try {
        data = parseJsonFromText(result.text);
        problems = validate(data, schema);
    } catch (e) {
        problems = [e.message];
    }

    if (problems.length) {
        const repair = await call(`${user}\n\n---\nYour previous reply was:\n${result.text}\n\nIt is invalid: ${problems.join('; ')}.\nReturn the corrected JSON object only.`);
        usage.input += repair.usage.input;
        usage.output += repair.usage.output;
        data = parseJsonFromText(repair.text);
        problems = validate(data, schema);

        if (problems.length) {
            throw new Error('The model returned data in an unexpected format: ' + problems.slice(0, 3).join('; '));
        }

        result = repair;
    }

    return { data, text: result.text, usage, model: result.model || config.model, mode };
}

/**
 * One agent turn with tools. messages (protocol-neutral):
 *   { role: 'user', text } | { role: 'assistant', text, toolCalls: [{ id, name, arguments }], raw? } | { role: 'tool', id, name, output }
 * Returns { text, toolCalls, raw, usage, model }.
 */
async function chat ({ config, apiKey, system, messages, tools, signal, fetchImpl }) {
    const protocol = PROTOCOLS[config.type];

    if (!protocol || !protocol.buildChat) throw new Error(`Provider type "${config.type}" does not support tools.`);
    if (!config.model) throw new Error('No model is set for this provider.');

    const { path, body } = protocol.buildChat({ config, system, messages, tools });
    const json = await requestJson({
        url: normalizeBaseUrl(config.baseUrl) + path,
        headers: authHeaders(config, apiKey),
        body,
        timeoutMs: config.timeoutMs || 120000,
        signal,
        fetchImpl
    });

    return protocol.parseChat(json);
}

/** GET {baseUrl}/models – supported by OpenAI and most compatible servers. */
async function listModels ({ config, apiKey, signal, fetchImpl }) {
    const json = await requestJson({
        url: normalizeBaseUrl(config.baseUrl) + '/models',
        method: 'GET',
        headers: authHeaders(config, apiKey),
        timeoutMs: Math.min(config.timeoutMs || 30000, 30000),
        signal,
        fetchImpl
    });

    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return list.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

module.exports = { PROTOCOLS, generateStructured, chat, listModels, authHeaders, normalizeBaseUrl };
