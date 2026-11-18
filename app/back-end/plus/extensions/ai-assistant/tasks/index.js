/**
 * AI tasks: prompt + JSON schema + post-processing.
 * Each task: { schemaName, schema, build(input) -> { system, user }, finish(data, input, helpers) -> result }
 */
const MAX_SOURCE_CHARS = 24000;

const LIMITS = { metaTitle: 70, metaDescription: 160, slug: 80, tag: 50 };

/** HTML or Markdown -> plain text for prompts. */
function toPlainText (text) {
    return String(text || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|figure|pre)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim()
        .slice(0, MAX_SOURCE_CHARS);
}

/** Cut at a word boundary without breaking the limit. */
function fitLength (text, max) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();

    if (clean.length <= max) return clean;

    const cut = clean.slice(0, max);
    const atSpace = cut.lastIndexOf(' ');
    return (atSpace > max * 0.6 ? cut.slice(0, atSpace) : cut).replace(/[\s,;:–—-]+$/, '');
}

function languageRule (language) {
    return language
        ? `Write in the language with code "${language}".`
        : 'Write in the same language as the content.';
}

/** Drafts follow the language of the author's brief; the site language is only a fallback. */
function briefLanguageRule (fallback) {
    return 'Write in the same language as the brief from the author' +
        (fallback ? ` (if the language of the brief is unclear, use the language with code "${fallback}").` : '.');
}

function draftRules (input) {
    const words = { short: 'about 300 words', medium: 'about 700 words', long: 'about 1500 words' }[input.length] || 'about 700 words';

    return [
        briefLanguageRule(input.language),
        `Length: ${words}.`,
        input.tone ? `Tone: ${input.tone}.` : 'Tone: clear, friendly and professional.',
        'markdown: the article body in Markdown. Use ## and ### headings, short paragraphs, lists and tables where useful. Do not repeat the title as a heading, no front matter. Use HTML only for elements or CSS classes that the website instructions explicitly allow.',
        'title: a concise, specific title.',
        'Do not invent statistics, quotes or sources; when a fact needs checking, write it so the author can verify it.'
    ];
}

function seoRules () {
    return [
        `metaTitle: compelling page title for search results, ideally 50–60 characters, never more than ${LIMITS.metaTitle}. Do not add the site name.`,
        `metaDescription: summary that makes people click, 120–155 characters, never more than ${LIMITS.metaDescription}. No quotes, no emojis, no hashtags.`,
        'slug: short URL slug of 2–6 meaningful words, lowercase, words separated by hyphens, Latin letters only (transliterate other scripts), no stop words, no dates.'
    ];
}

function tagRules (max) {
    return [
        `tags: between 1 and ${max} tags ordered by relevance.`,
        'Strongly prefer the existing tags of the website and copy their spelling exactly. Suggest a new tag only when no existing tag covers an important topic of the post.',
        'New tags: 1–3 words, same language and style as the existing tags (or as the post if there are none), no hashtags.',
        'mainTag: the single most relevant tag; it must be one of the returned tags.'
    ];
}

function draftUserBlock (input) {
    return [
        input.title ? `Working title: ${input.title}` : '',
        `Brief from the author:\n${String(input.brief || '').slice(0, 8000)}`,
        input.text ? `\nExisting text of the post (continue or build on it, do not repeat it):\n${toPlainText(input.text).slice(0, 8000)}` : ''
    ].filter(Boolean).join('\n\n');
}

function finishDraft (data, { markdownToHtml }) {
    const markdown = String(data.markdown || '').replace(/^#\s+.+\n+/, '').trim();
    return { title: fitLength(data.title, 200), markdown, html: markdownToHtml ? markdownToHtml(markdown) : '' };
}

function postBlock (input) {
    return `Title: ${input.title || '(no title)'}\n\nContent:\n${toPlainText(input.text) || '(empty)'}`;
}

const TASKS = {
    seo: {
        schemaName: 'seo_metadata',
        schema: {
            type: 'object',
            properties: {
                metaTitle: { type: 'string', maxLength: LIMITS.metaTitle },
                metaDescription: { type: 'string', maxLength: LIMITS.metaDescription },
                slug: { type: 'string', maxLength: LIMITS.slug }
            },
            required: ['metaTitle', 'metaDescription', 'slug']
        },
        build (input) {
            return {
                system: [
                    'You are an experienced SEO editor for a website built with the Publii static CMS.',
                    languageRule(input.language),
                    ...seoRules(),
                    'Base everything only on the content provided; do not invent facts.'
                ].join('\n'),
                user: postBlock(input) + (input.websiteName ? `\n\nWebsite: ${input.websiteName}` : '')
            };
        },
        finish (data, input, { createSlug }) {
            return {
                metaTitle: fitLength(data.metaTitle, LIMITS.metaTitle),
                metaDescription: fitLength(data.metaDescription, LIMITS.metaDescription),
                slug: (createSlug ? createSlug(data.slug) : String(data.slug)).slice(0, LIMITS.slug).replace(/-+$/, '')
            };
        }
    },

    tags: {
        schemaName: 'post_tags',
        schema: {
            type: 'object',
            properties: {
                tags: {
                    type: 'array',
                    maxItems: 8,
                    items: { type: 'object', properties: { name: { type: 'string', maxLength: LIMITS.tag } }, required: ['name'] }
                },
                mainTag: { type: 'string' }
            },
            required: ['tags', 'mainTag']
        },
        build (input) {
            const max = Math.min(Math.max(Number(input.maxTags) || 5, 1), 8);
            const existing = (input.existingTags || []).slice(0, 400);

            return {
                system: [
                    'You assign tags to blog posts of a website built with the Publii static CMS.',
                    ...tagRules(max)
                ].join('\n'),
                user: `Existing tags of the website (JSON): ${JSON.stringify(existing)}\n\n` + postBlock(input)
            };
        },
        finish (data, input) {
            const existing = new Map((input.existingTags || []).map(name => [String(name).toLowerCase().trim(), name]));
            const seen = new Set();
            const tags = [];

            for (const tag of data.tags || []) {
                const raw = String(tag.name || '').replace(/^#/, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.tag);
                const key = raw.toLowerCase();

                if (!raw || seen.has(key)) continue;

                seen.add(key);
                tags.push({ name: existing.get(key) || raw, isNew: !existing.has(key) });
            }

            const mainKey = String(data.mainTag || '').toLowerCase().trim();
            const main = tags.find(t => t.name.toLowerCase() === mainKey) || tags[0];

            return { tags, mainTag: main ? main.name : '' };
        }
    },

    draft: {
        schemaName: 'post_draft',
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                markdown: { type: 'string' }
            },
            required: ['title', 'markdown']
        },
        build (input) {
            return {
                system: ['You are a skilled writer creating blog posts for a website built with the Publii static CMS.', ...draftRules(input)].join('\n'),
                user: draftUserBlock(input)
            };
        },
        finish (data, input, helpers) {
            return finishDraft(data, helpers);
        }
    },

    /** Complete post in one request: title, content, SEO fields and tags. */
    post: {
        schemaName: 'complete_post',
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                markdown: { type: 'string' },
                metaTitle: { type: 'string', maxLength: LIMITS.metaTitle },
                metaDescription: { type: 'string', maxLength: LIMITS.metaDescription },
                slug: { type: 'string', maxLength: LIMITS.slug },
                tags: {
                    type: 'array',
                    maxItems: 8,
                    items: { type: 'object', properties: { name: { type: 'string', maxLength: LIMITS.tag } }, required: ['name'] }
                },
                mainTag: { type: 'string' }
            },
            required: ['title', 'markdown', 'metaTitle', 'metaDescription', 'slug', 'tags', 'mainTag']
        },
        build (input) {
            const max = Math.min(Math.max(Number(input.maxTags) || 5, 1), 8);

            return {
                system: [
                    'You are a skilled writer and SEO editor creating complete blog posts for a website built with the Publii static CMS.',
                    ...draftRules(input),
                    'metaTitle, metaDescription and slug describe the post you wrote; write them in the language of the post.',
                    ...seoRules(),
                    ...tagRules(max)
                ].join('\n'),
                user: `Existing tags of the website (JSON): ${JSON.stringify((input.existingTags || []).slice(0, 400))}\n\n` + draftUserBlock(input)
            };
        },
        finish (data, input, helpers) {
            return {
                ...finishDraft(data, helpers),
                seo: TASKS.seo.finish(data, input, helpers),
                ...TASKS.tags.finish(data, input)
            };
        }
    },

    rewrite: {
        schemaName: 'rewritten_text',
        schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text']
        },
        build (input) {
            const actions = {
                improve: 'Improve clarity, flow and style while keeping the meaning.',
                shorten: 'Make it noticeably shorter while keeping the key information.',
                expand: 'Expand it with more detail and explanation, without inventing facts.',
                fix: 'Fix grammar, spelling and punctuation only; change nothing else.',
                simplify: 'Rewrite it in simpler words that are easy to understand.'
            };
            const format = { html: 'HTML (keep the existing tags, links and structure; use only simple inline/block HTML)', markdown: 'Markdown (keep the existing formatting)' }[input.format] || 'plain text';

            return {
                system: [
                    'You edit fragments of blog posts for a website built with the Publii static CMS.',
                    input.action === 'custom' && input.instruction ? `Instruction from the author: ${String(input.instruction).slice(0, 1000)}` : (actions[input.action] || actions.improve),
                    'Keep the language of the fragment.',
                    `The fragment is ${format}. Return the edited fragment in the same format in "text", nothing else.`
                ].join('\n'),
                user: String(input.text || '').slice(0, MAX_SOURCE_CHARS)
            };
        },
        finish (data) {
            return { text: String(data.text || '').trim() };
        }
    },

    ping: {
        schemaName: 'connection_test',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        build () {
            return { system: 'You are a connection test.', user: 'Return {"ok": true}.' };
        },
        finish (data) {
            return { ok: data.ok === true };
        }
    }
};

module.exports = { TASKS, LIMITS, toPlainText, fitLength };
