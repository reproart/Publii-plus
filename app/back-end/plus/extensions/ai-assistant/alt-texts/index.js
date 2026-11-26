/**
 * AI alt texts – service: find images without alt text in posts and pages (content and featured images),
 * describe one image with a vision model, apply reviewed texts (with undo).
 * Used by the "AI alt texts" dialog (Tools / Site check) and the AI agent.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { listImages, applyAlts, needsAlt } = require('./images');
const { resolveFile, imageForModel, thumbnailFile, describeImage } = require('./describe');

const EDITORS = ['tinymce', 'blockeditor', 'markdown'];
const UNDO_KEEP = 10;

function parse (json, fallback) {
    try {
        return JSON.parse(json) || fallback;
    } catch (e) {
        return fallback;
    }
}

function safeSite (site) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(String(site || '')) || String(site).startsWith('.')) throw new Error('Invalid website.');
    return site;
}

/**
 * @param {object} o
 * @param {function} o.db              site → node:sqlite / better-sqlite3 handle
 * @param {function} o.siteDir         site → website folder (with input/)
 * @param {function} o.language        site → language code
 * @param {function} o.resolveProvider providerId → { provider, apiKey }
 * @param {function} o.generate        generateStructured
 * @param {function} [o.instructions]  site → (system → system with the owner's instructions)
 */
function createAltService ({ db, siteDir, language = () => '', resolveProvider, generate, instructions = () => s => s, now = () => Date.now() }) {
    const undo = new Map();
    const requests = new Map();
    let undoSeq = 0;

    function loadPost (site, id) {
        const handle = db(site);
        const row = handle.prepare("SELECT id, title, slug, text, status FROM posts WHERE id = @id AND status NOT LIKE '%trashed%'").get({ id: Number(id) });

        if (!row) return null;

        const core = parse((handle.prepare("SELECT value FROM posts_additional_data WHERE post_id = @id AND key = '_core'").get({ id: row.id }) || {}).value, {});
        const img = handle.prepare('SELECT id, url, additional_data FROM posts_images WHERE post_id = @id ORDER BY id DESC').get({ id: row.id });
        const data = img ? parse(img.additional_data, {}) : {};

        return {
            id: row.id,
            title: row.title,
            slug: row.slug,
            status: row.status,
            type: /is-page/.test(row.status) ? 'page' : 'post',
            editor: EDITORS.includes(core.editor) ? core.editor : 'tinymce',
            text: row.text || '',
            featured: img && img.url ? { rowId: img.id, url: img.url, alt: data.alt || '', caption: data.caption || '', data } : null
        };
    }

    function fileFor (site, post, image) {
        return resolveFile(image.src, { siteDir: siteDir(site), postId: post.id });
    }

    return {
        /** Posts and pages with images that have no alt text */
        scan (site, { postIds = null } = {}) {
            safeSite(site);

            const rows = db(site).prepare("SELECT id FROM posts WHERE status NOT LIKE '%trashed%' ORDER BY modified_at DESC").all();
            const out = [];

            for (const r of rows) {
                if (postIds && !postIds.map(Number).includes(r.id)) continue;

                const post = loadPost(site, r.id);
                const images = listImages(post).filter(needsAlt).map(image => {
                    const file = fileFor(site, post, image);

                    return {
                        id: image.id,
                        kind: image.kind,
                        src: image.src,
                        caption: image.caption || '',
                        describable: !!file && !/\.svg$/i.test(file),
                        reason: file ? (/\.svg$/i.test(file) ? 'SVG images are not described' : '') : (/^(https?:)?\/\//.test(image.src) ? 'external image' : 'file not found'),
                        thumb: file ? pathToFileURL(thumbnailFile(file)).href : ''
                    };
                });

                if (images.length) {
                    out.push({ postId: post.id, type: post.type, title: post.title, editor: post.editor, draft: /draft/.test(post.status), images });
                }
            }

            return out;
        },

        /** Alt text proposal for one image: { alt, decorative } */
        async describe (site, postId, imageId, { providerId, requestId } = {}) {
            safeSite(site);

            const post = loadPost(site, postId);

            if (!post) throw new Error('The post no longer exists.');

            const image = listImages(post).find(i => i.id === imageId);

            if (!image) throw new Error('The image is no longer in the post.');

            const file = fileFor(site, post, image);

            if (!file) throw new Error('The image file was not found.');

            const dataUrl = await imageForModel(file);

            if (!dataUrl) throw new Error('This image format cannot be sent to the model.');

            const { provider, apiKey } = await resolveProvider(providerId);
            const controller = new AbortController();

            if (requestId) requests.set(requestId, controller);

            try {
                const result = await describeImage({
                    generate,
                    provider: { config: provider, apiKey },
                    dataUrl,
                    title: post.title,
                    image,
                    language: language(site),
                    instructions: instructions(site),
                    signal: controller.signal
                });

                return { ...result, src: image.src };
            } finally {
                if (requestId) requests.delete(requestId);
            }
        },

        cancel (requestId) {
            const c = requests.get(requestId);
            if (c) c.abort();
            return !!c;
        },

        /**
         * Write reviewed alt texts. changes: [{ postId, alts: { [imageId]: alt }, srcs: { [imageId]: src } }]
         * An image whose src changed since the proposal (edited meanwhile) is skipped.
         * @returns {{ posts, images, skipped, undoId }}
         */
        apply (site, changes) {
            safeSite(site);

            const handle = db(site);
            const backup = [];
            let posts = 0;
            let images = 0;
            let skipped = 0;

            for (const change of changes || []) {
                const post = loadPost(site, change.postId);

                if (!post) {
                    skipped += Object.keys(change.alts || {}).length;
                    continue;
                }

                const current = new Map(listImages(post).map(i => [i.id, i.src]));
                const alts = {};

                for (const [id, alt] of Object.entries(change.alts || {})) {
                    if (current.get(id) === undefined || (change.srcs && change.srcs[id] !== undefined && change.srcs[id] !== current.get(id))) skipped++;
                    else alts[id] = alt;
                }

                const result = applyAlts(post, alts);

                if (!result.changed) continue;

                backup.push({ id: post.id, text: post.text, featured: post.featured ? { rowId: post.featured.rowId, data: post.featured.data } : null });

                if (result.text !== post.text) {
                    handle.prepare('UPDATE posts SET text = @text, modified_at = @modified WHERE id = @id').run({ text: result.text, modified: now(), id: post.id });
                }

                if (result.featuredAlt !== undefined && post.featured) {
                    handle.prepare('UPDATE posts_images SET additional_data = @data WHERE id = @id')
                        .run({ data: JSON.stringify({ ...post.featured.data, alt: result.featuredAlt }), id: post.featured.rowId });

                    if (result.text === post.text) handle.prepare('UPDATE posts SET modified_at = @modified WHERE id = @id').run({ modified: now(), id: post.id });
                }

                posts++;
                images += result.changed;
            }

            let undoId = null;

            if (backup.length) {
                undoId = `alt-${++undoSeq}`;
                undo.set(undoId, { site, backup });

                if (undo.size > UNDO_KEEP) undo.delete(undo.keys().next().value);
            }

            return { posts, images, skipped, undoId };
        },

        /** Restore the texts and featured image data from before apply() */
        undo (undoId) {
            const entry = undo.get(undoId);

            if (!entry) throw new Error('Nothing to undo.');

            const handle = db(entry.site);

            for (const b of entry.backup) {
                handle.prepare('UPDATE posts SET text = @text, modified_at = @modified WHERE id = @id').run({ text: b.text, modified: now(), id: b.id });

                if (b.featured) handle.prepare('UPDATE posts_images SET additional_data = @data WHERE id = @id').run({ data: JSON.stringify(b.featured.data), id: b.featured.rowId });
            }

            undo.delete(undoId);
            return { posts: entry.backup.length };
        }
    };
}

module.exports = { createAltService };
