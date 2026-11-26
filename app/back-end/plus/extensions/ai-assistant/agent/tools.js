/**
 * Tools of the AI agent.
 *
 *   kind 'read'   – runs at once: run(args, ctx) -> result
 *   kind 'write'  – needs the user's approval: plan(args, ctx) -> { title, details, diff, apply() }
 *                   apply() -> { result, undo() } ; the plan is shown to the user before anything changes
 *   kind 'client' – executed by the renderer (e.g. starting Publii's preview)
 *   alwaysAsk     – approval even when the user turned on auto-apply (publishing to the server)
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
        name: 'inbox_status',
        kind: 'read',
        description: 'Content inbox of this website (Markdown files from GitHub or a folder that become posts): settings, ' +
            'last runs and what the next import would do (new / changed / conflicts).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async (args, ctx) => {
            if (!ctx.inbox) throw new Error('The content inbox is not available.');

            const status = ctx.inbox.status(ctx.site);
            const c = status.config;
            const out = {
                source: c.source === 'folder' ? { folder: c.dir } : { github: c.repo, branch: c.branch, folder: c.folder },
                automatic: c.enabled ? `every ${c.intervalMinutes} min while Publii Plus is open` : 'off',
                newPostsAs: c.defaultStatus,
                syncAfterImport: c.autoSync,
                autoSyncPossible: status.canPublish ? 'no: ' + status.canPublish : 'yes',
                importedPosts: status.imported,
                lastRuns: status.log.slice(0, 5).map(l => ({ at: new Date(l.at).toISOString(), created: l.created, updated: l.updated, errors: l.errors, conflicts: l.conflicts, synced: l.synced, problem: l.error || l.syncError || '' }))
            };

            try {
                out.next = (await ctx.inbox.check(ctx.site)).items.filter(i => i.action !== 'unchanged');
            } catch (e) {
                out.next = 'cannot read the inbox: ' + e.message;
            }

            return out;
        }
    },
    {
        name: 'inbox_import',
        kind: 'write',
        alwaysAsk: true,
        description: 'Import new and changed Markdown files of the content inbox as posts now; optionally render and sync the website afterwards.',
        parameters: {
            type: 'object',
            properties: { publish: { type: 'boolean', description: 'Render and sync after the import (default: the inbox setting)' } },
            additionalProperties: false
        },
        async plan (args, ctx) {
            if (!ctx.inbox) throw new Error('The content inbox is not available.');

            const c = ctx.inbox.status(ctx.site).config;
            const items = (await ctx.inbox.check(ctx.site)).items.filter(i => i.action !== 'unchanged');
            const work = items.filter(i => ['create', 'update', 'unpublish'].includes(i.action));
            const publish = typeof args.publish === 'boolean' ? args.publish : c.autoSync;

            if (!work.length) throw new Error('Nothing to import: the inbox has no new or changed files.' + (items.length ? ' Other items: ' + items.map(i => `${i.path} (${i.action}${i.reason ? ': ' + i.reason : ''})`).join(', ') : ''));

            return {
                title: `Import ${work.length} file(s) from the content inbox` + (publish ? ' and sync the website' : ''),
                details: [
                    ...items.map(i => `${i.path}: ${i.action}${i.reason ? ' – ' + i.reason : ''}`),
                    `New posts as: ${c.defaultStatus}`
                ],
                diff: '',
                async apply () {
                    const entry = await ctx.inbox.run(ctx.site, { trigger: 'agent', publish });
                    return {
                        result: { created: entry.created, updated: entry.updated, errors: entry.errors, conflicts: entry.conflicts, synced: entry.synced, problem: entry.error || entry.syncError || '', items: entry.items }
                    };
                }
            };
        }
    },
    {
        name: 'publish_site',
        kind: 'write',
        alwaysAsk: true,
        description: 'Render the whole website and sync it to the server (like the Sync button). Use when the user asks to publish.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        plan (args, ctx) {
            if (!ctx.inbox) throw new Error('Publishing is not available.');

            const reason = ctx.inbox.status(ctx.site).canPublish;

            if (reason) throw new Error('Cannot sync automatically: ' + reason + '.');

            return {
                title: 'Render and sync the website',
                details: ['All changes saved in Publii go live on the server.'],
                diff: '',
                async apply () {
                    const out = await ctx.inbox.publish(ctx.site);
                    return { result: { ok: true, issues: !!out.issues } };
                }
            };
        }
    },
    {
        name: 'check_site',
        kind: 'read',
        description: 'Check the website before publishing: renders it like Sync (nothing is published) and reports broken links and ' +
            'missing files, images without alt text, heavy images/pages, titles, meta descriptions, H1, noindex/robots.txt/canonical, ' +
            'insecure http resources; optionally external links (slower). Use "last_report" to read the previous result without checking again. ' +
            'Results name the post/page id when the problem is in a post or page, so you can fix it with update_post.',
        parameters: {
            type: 'object',
            properties: {
                external_links: { type: 'boolean', description: 'Also open every link to other websites (takes longer). Default false.' },
                last_report: { type: 'boolean', description: 'Only return the last report, do not check again. Default false.' }
            },
            additionalProperties: false
        },
        run: async (args, ctx) => {
            if (!ctx.siteCheck) throw new Error('The site check is not available.');

            const report = args.last_report
                ? ctx.siteCheck.report(ctx.site)
                : await ctx.siteCheck.run(ctx.site, { rerender: true, external: !!args.external_links });

            if (!report) return { result: 'The website has not been checked yet.' };

            const byCheck = {};

            for (const i of report.issues) {
                const list = byCheck[i.check] || (byCheck[i.check] = { severity: i.severity, count: 0, examples: [] });
                list.count++;

                if (list.examples.length < 8) {
                    list.examples.push({
                        page: i.page || 'website',
                        ...(i.item ? { [i.item.type + 'Id']: i.item.id, title: i.item.title } : {}),
                        ...(i.target ? { target: clip(i.target, 160) } : {}),
                        ...(i.text ? { linkText: i.text } : {}),
                        ...(i.detail ? { detail: i.detail } : {})
                    });
                }
            }

            return {
                checkedAt: new Date(report.at).toISOString(),
                pages: report.pages,
                counts: report.counts,
                externalLinks: report.external.checked ? report.external : 'not checked',
                problems: byCheck
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
