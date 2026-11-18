/**
 * Tools of the AI agent.
 *
 *   kind 'read'   – runs at once: run(args, ctx) -> result
 *   kind 'write'  – needs the user's approval: plan(args, ctx) -> { title, details, diff, apply() }
 *                   apply() -> { result, undo() } ; the plan is shown to the user before anything changes
 *   kind 'client' – executed by the renderer (e.g. starting Publii's preview)
 *
 * ctx: { site, data (publii-data), theme (theme-editor service), markdownToHtml, createDiff }
 */
const MAX_TEXT = 20000;

function clip (text, max = MAX_TEXT) {
    text = String(text || '');
    return text.length > max ? text.slice(0, max) + `\n…[cut: ${text.length - max} more characters]` : text;
}

function requireString (value, name, { max = 100000, allowEmpty = false } = {}) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`"${name}" must be a non-empty string.`);
    if (value.length > max) throw new Error(`"${name}" is too long (max ${max} characters).`);
    return value;
}

function cleanTags (tags) {
    if (tags === undefined) return undefined;
    if (!Array.isArray(tags)) throw new Error('"tags" must be an array of strings.');
    return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 30);
}

/** Markdown from the model -> text in the format of the post's editor. */
function contentFor (editor, markdown, ctx) {
    if (editor === 'markdown') return markdown;
    if (editor === 'tinymce') return ctx.markdownToHtml(markdown);

    throw new Error('This post uses the block editor: its content can only be changed in the editor (AI panel). Title, tags and SEO fields can be changed.');
}

const TOOLS = [
    {
        name: 'get_site_info',
        kind: 'read',
        description: 'Website name, domain, language, theme and numbers of posts by status.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: (args, ctx) => ctx.data.siteInfo(ctx.site)
    },
    {
        name: 'list_posts',
        kind: 'read',
        description: 'List posts (newest first) with id, title, status, tags and dates. Filter by text in title/slug, status or tag.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text to search in titles and slugs' },
                status: { type: 'string', enum: ['any', 'draft', 'published', 'hidden', 'trashed', 'featured'] },
                tag: { type: 'string', description: 'Exact tag name' },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
                offset: { type: 'integer', minimum: 0 }
            },
            additionalProperties: false
        },
        run: (args, ctx) => ctx.data.listPosts(ctx.site, args)
    },
    {
        name: 'read_post',
        kind: 'read',
        description: 'Full post: title, status, editor type, tags, SEO fields and content (markdown for markdown posts, HTML otherwise).',
        parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
        run: (args, ctx) => {
            const post = ctx.data.readPost(ctx.site, args.id);
            return { ...post, text: clip(post.text) };
        }
    },
    {
        name: 'list_tags',
        kind: 'read',
        description: 'All tags with the number of posts.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: (args, ctx) => ({ tags: ctx.data.listTags(ctx.site) })
    },
    {
        name: 'list_theme_files',
        kind: 'read',
        description: 'Text files of the website theme (templates, partials, CSS, JS). "overridden" = changed for this website.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: (args, ctx) => {
            const list = ctx.theme.list(ctx.site);
            return { theme: list.theme, files: list.files.filter(f => /\.(hbs|html|css|js|json|txt|md|xml|svg)$/i.test(f.path)).slice(0, 400) };
        }
    },
    {
        name: 'read_theme_file',
        kind: 'read',
        description: 'Current content of a theme file (the website\'s edited copy if there is one).',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        run: (args, ctx) => {
            const file = ctx.theme.read(ctx.site, requireString(args.path, 'path', { max: 300 }));
            return { path: file.path, edited: file.override !== null, content: clip(file.content) };
        }
    },
    {
        name: 'create_post',
        kind: 'write',
        description: 'Create a new DRAFT post (markdown editor). Content is markdown without the title heading.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                content_markdown: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                meta_title: { type: 'string' },
                meta_description: { type: 'string' }
            },
            required: ['title', 'content_markdown'],
            additionalProperties: false
        },
        plan (args, ctx) {
            const title = requireString(args.title, 'title', { max: 300 }).trim();
            const text = requireString(args.content_markdown, 'content_markdown');
            const tags = cleanTags(args.tags) || [];
            const metaTitle = typeof args.meta_title === 'string' ? args.meta_title.slice(0, 300) : '';
            const metaDescription = typeof args.meta_description === 'string' ? args.meta_description.slice(0, 1000) : '';
            const details = [`Title: ${title}`, 'Status: draft (markdown editor)'];

            if (tags.length) details.push('Tags: ' + tags.join(', '));
            if (metaTitle) details.push('SEO title: ' + metaTitle);
            if (metaDescription) details.push('Meta description: ' + metaDescription);

            return {
                title: `Create draft "${title}"`,
                details,
                diff: ctx.createDiff(null, text, 'content.md'),
                apply () {
                    const { id } = ctx.data.createPost(ctx.site, { title, text, editor: 'markdown', tags, metaTitle, metaDescription });
                    return {
                        result: { ok: true, id, status: 'draft' },
                        postId: id,
                        undo: () => ctx.data.deletePost(ctx.site, id)
                    };
                }
            };
        }
    },
    {
        name: 'update_post',
        kind: 'write',
        description: 'Change fields of an existing post. Only the given fields change. content_markdown replaces the whole content ' +
            '(read the post first and keep what should stay). Not possible for block editor content.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                title: { type: 'string' },
                content_markdown: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags of the post' },
                meta_title: { type: 'string' },
                meta_description: { type: 'string' },
                status: { type: 'string', enum: ['draft', 'published'] }
            },
            required: ['id'],
            additionalProperties: false
        },
        plan (args, ctx) {
            const before = ctx.data.readPost(ctx.site, args.id);
            const fields = {};
            const details = [];
            let diff = '';

            if (typeof args.title === 'string' && args.title.trim() && args.title.trim() !== before.title) {
                fields.title = args.title.trim().slice(0, 300);
                details.push(`Title: "${before.title}" → "${fields.title}"`);
            }

            if (typeof args.content_markdown === 'string') {
                const text = contentFor(before.editor, requireString(args.content_markdown, 'content_markdown'), ctx);

                if (text !== before.text) {
                    fields.text = text;
                    diff = ctx.createDiff(before.text, text, before.editor === 'markdown' ? 'content.md' : 'content.html');
                    details.push('Content: replaced' + (before.editor === 'tinymce' ? ' (converted from markdown to HTML)' : ''));
                }
            }

            const tags = cleanTags(args.tags);

            if (tags && tags.join('\n') !== before.tags.join('\n')) {
                fields.tags = tags;
                details.push(`Tags: ${before.tags.join(', ') || '–'} → ${tags.join(', ') || '–'}`);
            }

            if (typeof args.meta_title === 'string' && args.meta_title !== before.metaTitle) {
                fields.metaTitle = args.meta_title.slice(0, 300);
                details.push(`SEO title: "${before.metaTitle}" → "${fields.metaTitle}"`);
            }

            if (typeof args.meta_description === 'string' && args.meta_description !== before.metaDescription) {
                fields.metaDescription = args.meta_description.slice(0, 1000);
                details.push(`Meta description: "${before.metaDescription}" → "${fields.metaDescription}"`);
            }

            if (typeof args.status === 'string' && args.status !== before.status) {
                fields.status = args.status;
                details.push(`Status: ${before.status} → ${args.status}`);
            }

            if (!Object.keys(fields).length) throw new Error('Nothing to change: the given values are the same as in the post.');

            const restore = {};

            for (const key of Object.keys(fields)) restore[key] = before[key];

            return {
                title: `Update post "${before.title}" (id ${before.id})`,
                details,
                diff,
                apply () {
                    ctx.data.updatePost(ctx.site, before.id, fields);
                    return {
                        result: { ok: true, id: before.id, changed: Object.keys(fields) },
                        postId: before.id,
                        undo: () => ctx.data.updatePost(ctx.site, before.id, restore)
                    };
                }
            };
        }
    },
    {
        name: 'write_theme_file',
        kind: 'write',
        description: 'Save a theme file for this website (stored as an override, the theme itself is not changed). ' +
            'Give the complete new file content; read the file first.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false
        },
        plan (args, ctx) {
            const rel = requireString(args.path, 'path', { max: 300 });
            const content = requireString(args.content, 'content', { max: 1000000, allowEmpty: true });
            let before = null;

            try {
                before = ctx.theme.read(ctx.site, rel);
            } catch (e) {
                if (!/not found/i.test(e.message)) throw e;
            }

            const check = ctx.theme.validate(rel, content);

            if (check.errors.length) {
                throw new Error('The file has errors: ' + check.errors.map(e => (e.line ? `line ${e.line}: ` : '') + e.message).join('; '));
            }

            const oldContent = before ? before.content : null;

            if (oldContent === content) throw new Error('Nothing to change: the content is the same.');

            return {
                title: `${before ? 'Edit' : 'Create'} theme file ${rel}`,
                details: check.warnings.map(w => 'Warning: ' + (w.line ? `line ${w.line}: ` : '') + w.message),
                diff: ctx.createDiff(oldContent, content, rel),
                apply () {
                    const out = ctx.theme.save(ctx.site, rel, content);

                    if (!out.ok) throw new Error('Not saved: ' + out.errors.map(e => e.message).join('; '));

                    const previousOverride = before ? before.override : null;

                    return {
                        result: { ok: true, path: rel },
                        undo: () => (previousOverride === null ? ctx.theme.revert(ctx.site, rel) : ctx.theme.save(ctx.site, rel, previousOverride))
                    };
                }
            };
        }
    },
    {
        name: 'preview_site',
        kind: 'client',
        description: 'Render the website preview in Publii and open it in the browser (after changes, when the user wants to see them).',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
];

function toolByName (name) {
    return TOOLS.find(t => t.name === name) || null;
}

/** Definitions sent to the model. */
function definitions () {
    return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

module.exports = { TOOLS, toolByName, definitions, clip, contentFor };
