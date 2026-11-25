/**
 * Content inbox importer: Markdown files (with front matter) -> Publii posts.
 *
 * Mapping per website (state.files): inbox path -> { sha, postId, importedAt, images: { path: { sha, filename } } }
 *   new file                 -> new post (markdown editor)
 *   changed file or images   -> the same post is updated
 *   post edited in Publii after the import -> "conflict", skipped (unless overwriteLocalEdits)
 *   post deleted in Publii   -> not re-imported
 *   file removed from inbox  -> onDelete: 'keep' (default) or 'draft'
 *
 * Front matter fields: title, slug, date, tags, status (published/draft), draft, featured, hidden,
 * meta_title, description (meta description), image (featured image) + image_alt, image_caption, image_credits.
 * Relative image links in the text are uploaded like images inserted in Publii's editor.
 */
const path = require('path');
const { parseFrontMatter } = require('./front-matter');

const MD = /\.(md|markdown)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function first (data, ...keys) {
    for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
    }

    return undefined;
}

function isInboxPost (rel) {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];

    if (!MD.test(name) || /^readme\.(md|markdown)$/i.test(name)) return false;
    return !parts.some(p => p.startsWith('_') || p.startsWith('.'));
}

function parseDate (value) {
    if (value === undefined || value === null || value === '') return null;

    const text = String(value).trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(:\d{2})?)$/, '$1T$2');
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : NaN;
}

function toList (value) {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function humanize (rel) {
    const name = path.posix.basename(rel).replace(MD, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[-_]+/g, ' ').trim();
    return name ? name[0].toUpperCase() + name.slice(1) : 'Untitled';
}

/** Relative image references in Markdown/HTML: [{ ref, path }] (path resolved inside the inbox) */
function findImages (body, mdRel) {
    const refs = new Set();
    const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
    let m;

    while ((m = re.exec(body))) refs.add(m[1] || m[2]);

    const dir = path.posix.dirname(mdRel);
    return [...refs]
        .filter(ref => !/^([a-z]+:|\/\/|\/|#)/i.test(ref) && IMAGE.test(ref.split(/[?#]/)[0]))
        .map(ref => {
            let clean = ref.split(/[?#]/)[0];

            try { clean = decodeURIComponent(clean); } catch (e) { /* keep as is */ }

            return { ref, path: path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean)) };
        })
        .filter(img => !img.path.startsWith('..'));
}

function replaceRef (body, ref, replacement) {
    return body.split('(' + ref).join('(' + replacement).split('<' + ref + '>').join(replacement)
        .split('"' + ref + '"').join('"' + replacement + '"').split("'" + ref + "'").join("'" + replacement + "'");
}

/** Front matter + body -> post fields (or { error }) */
function postFields (text, rel, { defaultStatus = 'published' } = {}) {
    const { data, body: rawBody, errors } = parseFrontMatter(text);

    if (errors.length) return { error: 'Front matter: ' + errors.join('; ') };

    let body = rawBody.replace(/^\s*\n/, '');
    let title = first(data, 'title');
    const h1 = /^#\s+(.+?)\s*#*\s*(\n|$)/.exec(body);

    if (h1 && (!title || h1[1].trim() === String(title).trim())) {
        title = title || h1[1].trim();
        body = body.slice(h1[0].length).replace(/^\s*\n/, '');
    }

    const date = parseDate(first(data, 'date', 'published', 'created'));

    if (Number.isNaN(date)) return { error: `Invalid date "${first(data, 'date', 'published', 'created')}" (use YYYY-MM-DD or YYYY-MM-DD HH:mm)` };

    const statusValue = String(first(data, 'status') || '').toLowerCase();
    let status = defaultStatus === 'draft' ? 'draft' : 'published';

    if (data.draft === true || statusValue === 'draft') status = 'draft';
    else if (['published', 'publish', 'public'].includes(statusValue) || data.draft === false) status = 'published';

    const flags = [];

    if (data.featured === true) flags.push('featured');
    if (data.hidden === true) flags.push('hidden');

    const image = first(data, 'image', 'featured_image', 'featuredImage', 'cover');

    return {
        title: String(title || humanize(rel)).slice(0, 300),
        slug: first(data, 'slug') ? String(first(data, 'slug')) : '',
        date,
        tags: toList(first(data, 'tags', 'tag')),
        status,
        flags,
        metaTitle: String(first(data, 'meta_title', 'metaTitle', 'seo_title') || ''),
        metaDescription: String(first(data, 'description', 'meta_description', 'metaDescription', 'excerpt') || ''),
        featured: image && !/^[a-z]+:/i.test(String(image)) ? {
            path: path.posix.normalize(path.posix.join(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), String(image))),
            alt: String(first(data, 'image_alt', 'featured_image_alt', 'alt') || ''),
            caption: String(first(data, 'image_caption', 'caption') || ''),
            credits: String(first(data, 'image_credits', 'credits') || '')
        } : null,
        body
    };
}

function createImporter ({ data, uploadImage, now = () => Date.now() }) {
    /** What would happen: [{ path, action, postId?, reason? }] */
    function plan (list, state, { overwriteLocalEdits = false, onDelete = 'keep' } = {}, site) {
        const shas = new Map(list.map(f => [f.path, f.sha]));
        const items = [];

        for (const file of list.filter(f => isInboxPost(f.path))) {
            const prev = state.files[file.path];

            if (!prev) {
                items.push({ path: file.path, action: 'create' });
                continue;
            }

            if (prev.removedInPublii || !data.exists(site, prev.postId)) {
                items.push({ path: file.path, action: 'skip', postId: prev.postId, reason: 'the post was deleted in Publii' });
                continue;
            }

            const imagesChanged = Object.entries(prev.images || {}).some(([p, img]) => shas.get(p) !== img.sha);

            if (prev.sha === file.sha && !imagesChanged) {
                items.push({ path: file.path, action: 'unchanged', postId: prev.postId });
                continue;
            }

            const modified = data.modifiedAt(site, prev.postId);

            if (!overwriteLocalEdits && modified && modified > prev.importedAt + 2000) {
                items.push({ path: file.path, action: 'conflict', postId: prev.postId, reason: 'the post was edited in Publii after the last import' });
                continue;
            }

            items.push({ path: file.path, action: 'update', postId: prev.postId });
        }

        for (const [rel, prev] of Object.entries(state.files)) {
            if (shas.has(rel) || prev.removedFromInbox) continue;
            items.push({ path: rel, action: onDelete === 'draft' ? 'unpublish' : 'removed', postId: prev.postId });
        }

        return items;
    }

    async function uploadImages (site, postId, source, shas, refs, prevImages) {
        const images = {};

        for (const img of refs) {
            if (!shas.has(img.path)) throw new Error(`Image not found in the inbox: ${img.path}`);
            if (images[img.path]) continue;

            const prev = prevImages[img.path];

            if (prev && prev.sha === shas.get(img.path) && prev.filename) {
                images[img.path] = prev;   // unchanged – keep the uploaded file
                continue;
            }

            const buffer = await source.read(img.path);
            const filename = await uploadImage(site, postId, buffer, path.posix.basename(img.path), img.featured ? 'featuredImages' : 'contentImages');
            images[img.path] = { sha: shas.get(img.path), filename };
        }

        return images;
    }

    async function importFile (site, source, shas, item, state, config) {
        const text = (await source.read(item.path)).toString('utf8');
        const fields = postFields(text, item.path, config);

        if (fields.error) throw new Error(fields.error);

        const prev = state.files[item.path] || {};
        const refs = findImages(fields.body, item.path);
        const imageRefs = fields.featured ? [...refs, { ref: null, path: fields.featured.path, featured: true }] : refs;
        let postId = item.postId;

        if (item.action === 'create') {
            ({ id: postId } = data.createPost(site, {
                title: fields.title,
                text: fields.body,
                editor: 'markdown',
                tags: fields.tags,
                metaTitle: fields.metaTitle,
                metaDescription: fields.metaDescription,
                slug: fields.slug,
                status: fields.status,
                flags: fields.flags,
                creationDate: fields.date
            }));

            // remember the post right away: if an image fails, the next run updates it instead of creating a duplicate
            state.files[item.path] = { sha: null, postId, importedAt: Math.max(now(), data.modifiedAt(site, postId) || 0), images: {} };
        }

        const images = await uploadImages(site, postId, source, shas, imageRefs, prev.images || {});
        let body = fields.body;

        for (const ref of refs) body = replaceRef(body, ref.ref, '#DOMAIN_NAME#' + images[ref.path].filename);

        const update = { text: body };

        if (item.action === 'update') {
            Object.assign(update, {
                title: fields.title,
                tags: fields.tags,
                metaTitle: fields.metaTitle,
                metaDescription: fields.metaDescription,
                status: fields.status,
                flags: fields.flags
            });

            if (fields.slug) update.slug = fields.slug;
            if (fields.date) update.creationDate = fields.date;
        }

        data.updatePost(site, postId, update);

        if (fields.featured) {
            data.setFeaturedImage(site, postId, { filename: images[fields.featured.path].filename, alt: fields.featured.alt, caption: fields.featured.caption, credits: fields.featured.credits });
        }

        state.files[item.path] = {
            sha: shas.get(item.path),
            postId,
            importedAt: Math.max(now(), data.modifiedAt(site, postId) || 0),
            images,
            title: fields.title,
            status: fields.status
        };

        return { postId, title: fields.title, status: fields.status };
    }

    /**
     * Run the inbox for one website. state is updated in place.
     * Returns { items, created, updated, changed (anything written), errors }
     */
    async function run ({ site, source, config = {}, state, dryRun = false }) {
        state.files = state.files || {};

        const list = await source.list();
        const shas = new Map(list.map(f => [f.path, f.sha]));
        const items = plan(list, state, config, site);
        const summary = { items, created: 0, updated: 0, unpublished: 0, conflicts: 0, errors: 0, changed: false };

        summary.conflicts = items.filter(i => i.action === 'conflict').length;

        if (dryRun) return summary;

        for (const item of items) {
            try {
                if (item.action === 'create' || item.action === 'update') {
                    const out = await importFile(site, source, shas, item, state, config);
                    Object.assign(item, out, { done: true });
                    summary[item.action === 'create' ? 'created' : 'updated']++;
                    summary.changed = true;
                } else if (item.action === 'unpublish') {
                    if (data.exists(site, item.postId)) {
                        data.updatePost(site, item.postId, { status: 'draft' });
                        summary.unpublished++;
                        summary.changed = true;
                    }

                    state.files[item.path].removedFromInbox = true;
                    item.done = true;
                } else if (item.action === 'removed') {
                    state.files[item.path].removedFromInbox = true;
                } else if (item.action === 'skip' && state.files[item.path]) {
                    state.files[item.path].removedInPublii = true;
                }
            } catch (error) {
                item.action = 'error';
                item.reason = error.message;
                summary.errors++;
            }
        }

        return summary;
    }

    return { plan, run };
}

module.exports = { createImporter, postFields, findImages, isInboxPost, parseDate };
