/**
 * Translations – one post translated with the AI provider: the text in batches of pieces (segments.js),
 * then the short fields (title, meta, featured image texts, new tag names) in one request.
 */
const { segment } = require('./segments');

const BATCH_CHARS = 5000;
const BATCH_PIECES = 40;

const PIECES_SCHEMA = {
    type: 'object',
    properties: {
        segments: { type: 'array', items: { type: 'string' }, description: 'Translations, same order and count as the input' }
    },
    required: ['segments'],
    additionalProperties: false
};

const FIELDS = ['title', 'metaTitle', 'metaDescription', 'featuredAlt', 'featuredCaption'];

const FIELDS_SCHEMA = {
    type: 'object',
    properties: {
        ...Object.fromEntries(FIELDS.map(f => [f, { type: 'string' }])),
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names, same order and count as the input' }
    },
    required: [...FIELDS, 'tags'],
    additionalProperties: false
};

function languageName (code) {
    const c = String(code || '').trim();

    if (!c) return '';

    try {
        const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(c);
        return name && name !== c ? `${name} (${c})` : c;
    } catch (e) {
        return c;
    }
}

function systemPrompt ({ from, to, glossary }) {
    const lines = [
        `You are a professional translator of website content. Translate from ${languageName(from) || 'the source language'} to ${languageName(to)}.`,
        'Write natural, fluent text for native readers of the target language; keep the meaning, tone, terminology and formatting of the original.',
        'Keep exactly as they are: HTML tags and attributes (except the text of alt and title attributes, which you translate), Markdown syntax, URLs and file names,',
        'the tokens #DOMAIN_NAME# and #INTERNAL_LINK#/..., shortcodes in square brackets such as [map ...] or [contact-form], code (inline and blocks), e-mail addresses and {{ }} placeholders.',
        'Do not add notes, explanations or quotes around the translation. Text that is already in the target language, names and brand names stay unchanged.'
    ];

    if (glossary && String(glossary).trim()) {
        lines.push('', 'Glossary and notes from the website owner (always follow them):', String(glossary).trim());
    }

    return lines.join('\n');
}

function batches (pieces) {
    const out = [];
    let current = [];
    let size = 0;

    pieces.forEach((piece, index) => {
        if (current.length && (size + piece.length > BATCH_CHARS || current.length >= BATCH_PIECES)) {
            out.push(current);
            current = [];
            size = 0;
        }

        current.push(index);
        size += piece.length;
    });

    if (current.length) out.push(current);
    return out;
}

const addUsage = (total, usage = {}) => {
    total.input += usage.input || 0;
    total.output += usage.output || 0;
};

/**
 * @param {object} o
 * @param {object} o.post      { title, text, editor, metaTitle, metaDescription, featured: { alt, caption } | null }
 * @param {string[]} o.newTags tag names without a cached translation
 * @param {function} o.generate (system, user, schema, schemaName) → { data, usage }
 * @returns {Promise<{ title, text, metaTitle, metaDescription, featuredAlt, featuredCaption, tags: Object<string,string>, usage }>}
 */
async function translatePost ({ post, newTags = [], from, to, glossary = '', generate, onProgress = () => {} }) {
    const system = systemPrompt({ from, to, glossary });
    const usage = { input: 0, output: 0 };
    const { pieces, rebuild } = segment(post.text, post.editor);
    const translated = pieces.slice();
    const groups = batches(pieces);
    let done = 0;

    const run = async indexes => {
        const input = indexes.map(i => pieces[i]);
        const out = await generate(system,
            `Translate each of the ${input.length} segments (parts of one article, in order). Return {"segments": [...]} with exactly ${input.length} strings.\n\n` +
            JSON.stringify({ segments: input }),
            PIECES_SCHEMA, 'translation');

        addUsage(usage, out.usage);
        return Array.isArray(out.data.segments) ? out.data.segments : [];
    };

    for (const group of groups) {
        let result = await run(group);

        // the model merged or split segments: translate them one by one
        if (result.length !== group.length || result.some(s => typeof s !== 'string')) {
            result = [];

            for (const i of group) {
                const one = await run([i]);
                result.push(typeof one[0] === 'string' ? one.join('\n\n') : pieces[i]);
            }
        }

        group.forEach((pieceIndex, i) => { translated[pieceIndex] = result[i]; });
        done += group.length;
        onProgress({ done, total: pieces.length });
    }

    const fields = {
        title: post.title || '',
        metaTitle: post.metaTitle || '',
        metaDescription: post.metaDescription || '',
        featuredAlt: (post.featured && post.featured.alt) || '',
        featuredCaption: (post.featured && post.featured.caption) || ''
    };
    const out = await generate(system,
        'Translate the fields of the article (empty strings stay empty; the caption may contain HTML) and the tag names ' +
        `(${newTags.length} – same order and count, short like the originals). Return the same JSON structure.\n\n` +
        JSON.stringify({ ...fields, tags: newTags }),
        FIELDS_SCHEMA, 'translation_fields');

    addUsage(usage, out.usage);

    const result = { text: rebuild(translated), tags: {}, usage };

    for (const f of FIELDS) result[f] = fields[f] ? String(out.data[f] || '').trim() || fields[f] : '';

    const tagNames = Array.isArray(out.data.tags) && out.data.tags.length === newTags.length ? out.data.tags : newTags;
    newTags.forEach((name, i) => { result.tags[name] = String(tagNames[i] || '').trim() || name; });

    return result;
}

module.exports = { translatePost, systemPrompt, languageName, batches, PIECES_SCHEMA, FIELDS_SCHEMA };
