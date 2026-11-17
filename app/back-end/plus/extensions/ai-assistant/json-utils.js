/**
 * Helpers for structured model output: tolerant JSON extraction and a small JSON-schema validator
 * (only the subset used by our task schemas: object/array/string/boolean/integer/number, required,
 * enum, maxLength, maxItems, additionalProperties: false).
 */

/** Parse JSON from a model reply that may contain ```json fences or text around the object. */
function parseJsonFromText (text) {
    if (text && typeof text === 'object') {
        return text;
    }

    let source = String(text || '').trim();
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fenced) {
        source = fenced[1].trim();
    }

    try {
        return JSON.parse(source);
    } catch (e) {
        // fall through to the balanced-brace scan
    }

    const start = source.indexOf('{');

    if (start === -1) {
        throw new Error('The model did not return JSON.');
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
        const ch = source[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;

            if (depth === 0) {
                return JSON.parse(source.slice(start, i + 1));
            }
        }
    }

    throw new Error('The model returned incomplete JSON.');
}

/** Returns a list of problems ([] when valid). Length limits are reported but not fatal (see `strictLengths`). */
function validate (value, schema, path = '$', { strictLengths = false } = {}) {
    const errors = [];
    const type = schema.type;

    if (type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return [`${path} must be an object`];
        }

        for (const key of schema.required || []) {
            if (!(key in value)) errors.push(`${path}.${key} is required`);
        }

        for (const [key, sub] of Object.entries(schema.properties || {})) {
            if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`, { strictLengths }));
        }

        return errors;
    }

    if (type === 'array') {
        if (!Array.isArray(value)) return [`${path} must be an array`];
        if (strictLengths && schema.maxItems && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
        value.forEach((item, i) => errors.push(...validate(item, schema.items || {}, `${path}[${i}]`, { strictLengths })));
        return errors;
    }

    if (type === 'string') {
        if (typeof value !== 'string') return [`${path} must be a string`];
        if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
        if (strictLengths && schema.maxLength && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
        return errors;
    }

    if (type === 'boolean' && typeof value !== 'boolean') return [`${path} must be a boolean`];
    if ((type === 'integer' || type === 'number') && typeof value !== 'number') return [`${path} must be a number`];

    return errors;
}

/**
 * OpenAI strict structured outputs reject some keywords (e.g. maxLength in older models, minItems...).
 * Produce a copy without validation-only keywords; limits are stated in the prompt and enforced locally.
 */
function toStrictSchema (schema) {
    if (Array.isArray(schema)) return schema.map(toStrictSchema);
    if (!schema || typeof schema !== 'object') return schema;

    const out = {};

    for (const [key, value] of Object.entries(schema)) {
        if (['maxLength', 'maxItems', 'minItems', 'minLength'].includes(key)) continue;
        out[key] = toStrictSchema(value);
    }

    if (out.type === 'object') {
        out.additionalProperties = false;
        out.required = Object.keys(out.properties || {});
    }

    return out;
}

module.exports = { parseJsonFromText, validate, toStrictSchema };
