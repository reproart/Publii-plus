/**
 * Translations – mirroring posts of a source website into language websites (other Publii websites).
 *
 *  - published posts of the source get a translated copy in every target website: same slug, date, flags, tags
 *    (new tags keep the slug of the source tag), featured image and images (the media folder is copied)
 *  - content changes are translated again; changes of status, slug, date, template and view settings are copied
 *    without a translation; a post edited in the target website is not overwritten (unless asked)
 *  - an existing post with the same slug in the target website is linked, not overwritten
 *  - internal links are mapped to the target website (links.js)
 *
 * All database work is synchronous: a target database that is not open in Publii is opened only for the duration
 * of one write (Publii's models read the handle from app.getDbForSite()).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { splitStatus } = require('../ai-assistant/agent/publii-data');
const { remapLinks, linkedFiles } = require('./links');

const MANAGED_FLAGS = ['featured', 'hidden', 'excluded_homepage'];
const META_KEYS = ['status', 'flags', 'slug', 'created', 'template', 'viewSettings', 'metaRobots', 'mainTag'];
const EDIT_TOLERANCE = 1000;

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

function parse (json, fallback) {
    try {
        const value = json ? JSON.parse(json) : fallback;
        return value && typeof value === 'object' ? value : fallback;
    } catch (e) {
        return fallback;
    }
}

/** What is translated: a change here means a new translation */
function contentHash (post) {
    return hash([
        post.title, post.text, post.editor, post.metaTitle, post.metaDescription,
        post.tags.map(t => t.name),
        post.featured ? [post.featured.url, post.featured.alt, post.featured.caption, post.featured.credits] : null
    ]);
}

/** What is copied as it is */
function metaOf (post) {
    return {
        status: post.status === 'published' && !post.trashed ? 'published' : 'draft',
        flags: post.flags.filter(f => MANAGED_FLAGS.includes(f)).sort(),
        slug: post.slug,
        created: post.created,
        template: post.template || '',
        viewSettings: JSON.stringify(post.viewSettings || {}),
        metaRobots: post.metaRobots || '',
        mainTag: post.mainTag || ''
    };
}

const changedMeta = (a = {}, b = {}) => META_KEYS.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

const translatable = post => post.status === 'published' && !post.trashed;

/** All posts of a website (pages are not mirrored), oldest first – links to older posts can be mapped right away */
function readPosts (db) {
    const rows = db.prepare(`SELECT p.id, p.title, p.slug, p.text, p.status, p.created_at, p.modified_at, p.template,
            pi.url AS image, pi.additional_data AS imageData
        FROM posts AS p LEFT JOIN posts_images AS pi ON pi.id = p.featured_image_id AND p.featured_image_id > 0
        WHERE p.status NOT LIKE '%is-page%' ORDER BY p.created_at, p.id`).all();
    const extra = {};

    for (const r of db.prepare("SELECT post_id, key, value FROM posts_additional_data WHERE key IN ('_core', 'postViewSettings')").all()) {
        extra[r.post_id] = extra[r.post_id] || {};
        extra[r.post_id][r.key] = parse(r.value, {});
    }

    const tagsById = new Map(db.prepare('SELECT id, name, slug FROM tags').all().map(t => [t.id, { id: t.id, name: t.name, slug: t.slug }]));
    const tagsOf = {};

    for (const r of db.prepare('SELECT post_id, tag_id FROM posts_tags').all()) {
        if (tagsById.has(r.tag_id)) (tagsOf[r.post_id] = tagsOf[r.post_id] || []).push(tagsById.get(r.tag_id));
    }

    return rows.map(r => {
        const s = splitStatus(r.status);
        const core = (extra[r.id] || {})._core || {};
        const image = r.image ? parse(r.imageData, {}) : null;
        const mainTag = core.mainTag && tagsById.get(Number(core.mainTag));

        return {
            id: r.id,
            title: r.title || '',
            slug: r.slug || '',
            text: r.text || '',
            editor: ['tinymce', 'blockeditor', 'markdown'].includes(core.editor) ? core.editor : 'tinymce',
            status: s.status,
            flags: s.flags.filter(f => f !== 'trashed'),
            trashed: s.flags.includes('trashed'),
            created: Number(r.created_at),
            modified: Number(r.modified_at),
            template: r.template || '',
            metaTitle: core.metaTitle || '',
            metaDescription: core.metaDesc || '',
            metaRobots: core.metaRobots || '',
            mainTag: mainTag ? mainTag.name : (typeof core.mainTag === 'string' ? core.mainTag : ''),
            viewSettings: (extra[r.id] || {}).postViewSettings || {},
            tags: (tagsOf[r.id] || []).sort((a, b) => a.name.localeCompare(b.name)),
            featured: r.image ? { url: r.image, alt: image.alt || '', caption: image.caption || '', credits: image.credits || '' } : null
        };
    });
}

/** Slugs of the source items internal links can point to */
function readRefs (db, posts) {
    return {
        posts: new Map(posts.map(p => [p.id, p.slug])),
        pages: new Map(db.prepare("SELECT id, slug FROM posts WHERE status LIKE '%is-page%'").all().map(r => [r.id, r.slug])),
        tags: new Map(db.prepare('SELECT id, name, slug FROM tags').all().map(t => [t.id, { name: t.name, slug: t.slug }]))
    };
}

/** What the target website has: posts by id/slug, pages by slug, tags by slug/name */
function readTarget (db) {
    const posts = new Map();
    const bySlug = new Map();
    const pagesBySlug = new Map();

    for (const r of db.prepare('SELECT id, slug, status, modified_at FROM posts').all()) {
        const s = splitStatus(r.status);
        const trashed = s.flags.includes('trashed');

        if (s.flags.includes('is-page')) {
            if (!trashed) pagesBySlug.set(r.slug, r.id);
            continue;
        }

        posts.set(r.id, { id: r.id, slug: r.slug, modified: Number(r.modified_at), trashed });
        if (!trashed) bySlug.set(r.slug, r.id);
    }

    const tags = db.prepare('SELECT id, name, slug FROM tags').all();

    return {
        posts,
        bySlug,
        pagesBySlug,
        tagsBySlug: new Map(tags.map(t => [t.slug, { id: t.id, name: t.name }])),
        tagsByName: new Map(tags.map(t => [t.name, { id: t.id, slug: t.slug }]))
    };
}

/**
 * @param {object} o
 * @param {object} o.app     Publii's App (sitesDir, getDbForSite, setDbForSite, closeDbForSite)
 * @param {object} o.data    createPubliiData({ app })
 * @param {function} o.openDb  path → database handle (DBUtils over node:sqlite)
 */
function createEngine ({ app, data, openDb, now = () => Date.now() }) {
    /** Run fn(db) with the website's database, opened just for this call when Publii has not opened it. */
    function withSite (site, fn) {
        const open = app.getDbForSite(site);

        if (open) return fn(open);

        const file = path.join(app.sitesDir, site, 'input', 'db.sqlite');

        if (!fs.existsSync(file)) throw new Error(`The website "${site}" has no database.`);

        const handle = openDb(file);
        app.setDbForSite(site, handle);

        try {
            const result = fn(handle);

            if (result && typeof result.then === 'function') throw new Error('withSite() needs a synchronous function.');
            return result;
        } finally {
            app.closeDbForSite(site);
        }
    }

    const mediaDir = (site, kind, id) => path.join(app.sitesDir, site, 'input', 'media', kind, String(id));

    function source (site) {
        return withSite(site, db => {
            const posts = readPosts(db);
            return { posts, refs: readRefs(db, posts) };
        });
    }

    const entryOf = (state, sourceId, target) => ((state.posts || {})[sourceId] || {})[target] || null;

    function setEntry (state, sourceId, target, entry) {
        state.posts = state.posts || {};
        state.posts[sourceId] = state.posts[sourceId] || {};

        if (entry) state.posts[sourceId][target] = entry;
        else delete state.posts[sourceId][target];

        if (!Object.keys(state.posts[sourceId]).length) delete state.posts[sourceId];
    }

    /** Tag names of the source post in the target website still without a translation */
    function untranslatedTags (info, post, cache = {}) {
        return post.tags.filter(t => !info.tagsBySlug.has(t.slug) && !cache[t.name]).map(t => t.name);
    }

    /** The same, read right before a translation (earlier translations of the run may have added the tags) */
    function newTags ({ target, post, state }) {
        return withSite(target, db => untranslatedTags(readTarget(db), post, ((state.tags || {})[target]) || {}));
    }

    /**
     * What each source post needs in each target website.
     * @returns {Array<{ sourceId, title, target, state, action, changed, reason, targetId, untranslatedTags }>}
     *   state:  new | linked | outdated | current | edited | deleted | waiting | source-deleted
     *   action: create | link | update | meta | unpublish | null
     */
    function plan ({ src, targets, state, force = {} }) {
        const items = [];

        for (const target of targets) {
            const info = withSite(target, readTarget);
            const mapped = new Set();

            for (const sourceId of Object.keys(state.posts || {})) {
                const e = entryOf(state, sourceId, target);
                if (e) mapped.add(e.targetId);
            }

            for (const post of src.posts) {
                const entry = entryOf(state, post.id, target);
                const t = entry ? info.posts.get(entry.targetId) : null;
                const forced = !!force[post.id + '>' + target];
                const item = { sourceId: post.id, title: post.title, target, state: '', action: null, changed: [], reason: '', targetId: entry ? entry.targetId : null };
                const hashNow = contentHash(post);
                const meta = metaOf(post);

                if (!entry) {
                    const sameSlug = info.bySlug.get(post.slug);

                    if (!translatable(post) && !forced) {
                        item.state = 'waiting';
                        item.reason = 'not published';
                    } else if (sameSlug && !mapped.has(sameSlug)) {
                        item.state = 'linked';
                        item.action = 'link';
                        item.targetId = sameSlug;
                        item.reason = 'a post with the same slug already exists – it is kept as the translation';
                    } else {
                        item.state = 'new';
                        item.action = 'create';
                    }
                } else if (!t || t.trashed) {
                    item.state = 'deleted';
                    item.reason = t ? 'the translation is in the trash' : 'the translation was deleted';
                } else {
                    const edited = t.modified > (entry.targetModified || 0) + EDIT_TOLERANCE;
                    const changed = changedMeta(entry.meta, meta);

                    item.changed = changed;

                    if (forced) {
                        item.state = entry.manual ? 'linked' : edited ? 'edited' : 'outdated';
                        item.action = 'update';
                        item.reason = 'overwrite';
                    } else if (entry.manual) {
                        item.state = 'linked';
                    } else if (hashNow !== entry.hash && translatable(post)) {
                        item.state = edited ? 'edited' : 'outdated';
                        item.action = edited ? (changed.length ? 'meta' : null) : 'update';

                        if (edited) item.reason = 'changed in the target website – not overwritten';
                    } else {
                        item.state = edited ? 'edited' : hashNow !== entry.hash ? 'waiting' : 'current';
                        item.action = changed.length ? 'meta' : null;
                    }
                }

                items.push(item);
            }

            // source posts deleted in Publii: their translations become drafts
            const ids = new Set(src.posts.map(p => String(p.id)));

            for (const sourceId of Object.keys(state.posts || {})) {
                const entry = entryOf(state, sourceId, target);

                if (!entry || ids.has(String(sourceId))) continue;

                const t = info.posts.get(entry.targetId);

                items.push({
                    sourceId: Number(sourceId),
                    title: entry.title || '',
                    target,
                    state: 'source-deleted',
                    action: !entry.sourceDeleted && t && !t.trashed ? 'unpublish' : null,
                    changed: [],
                    reason: 'the source post was deleted',
                    targetId: entry.targetId
                });
            }
        }

        return items;
    }

    /** Make sure the target website has the post's tags (translated names, source slugs); returns their names */
    function prepareTags (db, post, cache, translated) {
        const names = [];

        for (const tag of post.tags) {
            const bySlug = db.prepare('SELECT id, name FROM tags WHERE slug = @slug').get({ slug: tag.slug });

            if (bySlug) {
                cache[tag.name] = bySlug.name;
                names.push(bySlug.name);
                continue;
            }

            const name = translated[tag.name] || cache[tag.name] || tag.name;

            if (!db.prepare('SELECT id FROM tags WHERE name = @name').get({ name })) {
                // created here so that it keeps the slug of the source tag (Publii would make one from the translated name)
                db.prepare("INSERT INTO tags VALUES(null, @name, @slug, '', '')").run({ name, slug: tag.slug });
            }

            cache[tag.name] = name;
            names.push(name);
        }

        return [...new Set(names)];
    }

    function resolver ({ db, target, state, refs, cache }) {
        const info = readTarget(db);

        return (type, id) => {
            if (type === 'post') {
                const entry = entryOf(state, id, target);
                const t = entry && info.posts.get(entry.targetId);

                if (t && !t.trashed) return entry.targetId;
                return refs.posts.has(id) ? info.bySlug.get(refs.posts.get(id)) || null : null;
            }

            if (type === 'page') return refs.pages.has(id) ? info.pagesBySlug.get(refs.pages.get(id)) || null : null;

            if (type === 'tag') {
                const tag = refs.tags.get(id);

                if (!tag) return null;

                const bySlug = info.tagsBySlug.get(tag.slug);
                const byName = cache[tag.name] && info.tagsByName.get(cache[tag.name]);

                return (bySlug && bySlug.id) || (byName && byName.id) || null;
            }

            return null;
        };
    }

    function copyMedia (sourceSite, sourceId, target, targetId, text) {
        const from = mediaDir(sourceSite, 'posts', sourceId);

        if (fs.existsSync(from)) fs.cpSync(from, mediaDir(target, 'posts', targetId), { recursive: true, force: true });

        for (const file of linkedFiles(text)) {
            const a = path.join(app.sitesDir, sourceSite, 'input', file);
            const b = path.join(app.sitesDir, target, 'input', file);

            if (fs.existsSync(a) && !fs.existsSync(b)) {
                fs.mkdirSync(path.dirname(b), { recursive: true });
                fs.copyFileSync(a, b);
            }
        }
    }

    function setFeatured (target, targetId, post, translation) {
        const file = post.featured && path.join(mediaDir(target, 'posts', targetId), post.featured.url);

        if (file && fs.existsSync(file)) {
            data.setFeaturedImage(target, targetId, {
                filename: post.featured.url,
                alt: translation ? translation.featuredAlt : post.featured.alt,
                caption: translation ? translation.featuredCaption : post.featured.caption,
                credits: post.featured.credits
            });
        } else {
            data.setFeaturedImage(target, targetId, null);
        }
    }

    function writeMeta (db, target, targetId, meta, keys, tagId) {
        const row = db.prepare('SELECT status FROM posts WHERE id = @id').get({ id: targetId });

        if (!row) return;

        if (keys.includes('slug')) data.updatePost(target, targetId, { slug: meta.slug });
        if (keys.includes('created')) data.updatePost(target, targetId, { creationDate: meta.created });

        const set = {};

        if (keys.includes('status') || keys.includes('flags')) {
            const s = splitStatus(row.status);
            set.status = [meta.status, ...s.flags.filter(f => !MANAGED_FLAGS.includes(f)), ...meta.flags].join(',');
        }

        if (keys.includes('template')) set.template = meta.template;

        const columns = Object.keys(set);

        if (columns.length) {
            db.prepare(`UPDATE posts SET ${columns.map(c => `${c} = @${c}`).join(', ')}, modified_at = @modified WHERE id = @id`)
                .run({ ...set, modified: Date.now(), id: targetId });
        }

        if (keys.includes('viewSettings')) {
            db.prepare("DELETE FROM posts_additional_data WHERE post_id = @id AND key = 'postViewSettings'").run({ id: targetId });
            db.prepare("INSERT INTO posts_additional_data VALUES(null, @id, 'postViewSettings', @value)").run({ id: targetId, value: meta.viewSettings || '{}' });
        }

        if (keys.includes('metaRobots') || keys.includes('mainTag')) {
            const core = parse((db.prepare("SELECT value FROM posts_additional_data WHERE post_id = @id AND key = '_core'").get({ id: targetId }) || {}).value, {});

            if (keys.includes('metaRobots')) core.metaRobots = meta.metaRobots;
            if (keys.includes('mainTag')) core.mainTag = meta.mainTag ? tagId(meta.mainTag) || '' : '';

            db.prepare("DELETE FROM posts_additional_data WHERE post_id = @id AND key = '_core'").run({ id: targetId });
            db.prepare("INSERT INTO posts_additional_data VALUES(null, @id, '_core', @value)").run({ id: targetId, value: JSON.stringify(core) });
        }
    }

    /** Publii moves input/media/posts/temp (images of a new post being edited) into every newly created post */
    function keepTempImages (target, fn) {
        const temp = path.join(app.sitesDir, target, 'input', 'media', 'posts', 'temp');
        const aside = temp + '-plus-' + now();

        if (!fs.existsSync(temp)) return fn();

        fs.renameSync(temp, aside);

        try {
            return fn();
        } finally {
            fs.renameSync(aside, temp);
        }
    }

    /**
     * Write a translation (create or update) – synchronous.
     * @returns entry stored in the state
     */
    function write ({ sourceSite, target, post, translation, item, state, refs }) {
        state.tags = state.tags || {};
        state.tags[target] = state.tags[target] || {};

        const cache = state.tags[target];
        const meta = metaOf(post);
        const old = entryOf(state, post.id, target);

        return withSite(target, db => {
            const tags = prepareTags(db, post, cache, translation.tags || {});
            const mainTagName = post.mainTag ? (post.tags.find(t => t.name === post.mainTag) ? cache[post.mainTag] || post.mainTag : '') : '';
            const resolve = resolver({ db, target, state, refs: refs || { posts: new Map(), pages: new Map(), tags: new Map() }, cache });
            const linked = remapLinks(translation.text, resolve);
            let targetId = item.targetId;

            if (item.action === 'create') {
                targetId = keepTempImages(target, () => data.createPost(target, {
                    title: translation.title,
                    text: linked.text,
                    editor: post.editor,
                    tags,
                    metaTitle: translation.metaTitle,
                    metaDescription: translation.metaDescription,
                    slug: post.slug,
                    status: meta.status,
                    flags: meta.flags,
                    creationDate: post.created,
                    template: post.template,
                    extra: { metaRobots: post.metaRobots || 'index, follow', mainTag: mainTagName },
                    viewSettings: post.viewSettings
                }).id);
            } else {
                data.updatePost(target, targetId, {
                    title: translation.title,
                    text: linked.text,
                    tags,
                    metaTitle: translation.metaTitle,
                    metaDescription: translation.metaDescription
                });
                writeMeta(db, target, targetId, meta, META_KEYS, name => {
                    const t = db.prepare('SELECT id FROM tags WHERE name = @name').get({ name: cache[name] || name });
                    return t ? t.id : '';
                });
            }

            // absolute paths to the post's media folder (rare)
            const srcMedia = `media/posts/${post.id}/`;

            if (linked.text.includes(srcMedia)) {
                db.prepare('UPDATE posts SET text = @text WHERE id = @id').run({ text: linked.text.split(srcMedia).join(`media/posts/${targetId}/`), id: targetId });
            }

            copyMedia(sourceSite, post.id, target, targetId, linked.text);
            setFeatured(target, targetId, post, translation);

            const actual = db.prepare('SELECT slug, modified_at FROM posts WHERE id = @id').get({ id: targetId });

            return {
                targetId,
                title: post.title,
                hash: contentHash(post),
                meta,
                targetModified: Number(actual.modified_at),
                translatedAt: now(),
                createdAt: old && old.createdAt ? old.createdAt : now(),
                unresolved: linked.unresolved,
                slugNote: actual.slug !== post.slug ? actual.slug : ''
            };
        });
    }

    /** Copy status/slug/date/... without a translation – synchronous */
    function writeMetaOnly ({ target, post, item, state }) {
        const entry = entryOf(state, post.id, target);
        const meta = metaOf(post);
        const cache = ((state.tags || {})[target]) || {};

        return withSite(target, db => {
            const before = db.prepare('SELECT modified_at FROM posts WHERE id = @id').get({ id: entry.targetId });
            const wasEdited = !before || Number(before.modified_at) > (entry.targetModified || 0) + EDIT_TOLERANCE;

            writeMeta(db, target, entry.targetId, meta, item.changed, name => {
                const t = db.prepare('SELECT id FROM tags WHERE name = @name').get({ name: cache[name] || name });
                return t ? t.id : '';
            });

            const after = db.prepare('SELECT modified_at FROM posts WHERE id = @id').get({ id: entry.targetId });

            return { ...entry, meta, targetModified: wasEdited || !after ? entry.targetModified : Number(after.modified_at) };
        });
    }

    function unpublish ({ target, entry }) {
        return withSite(target, db => {
            const before = db.prepare('SELECT modified_at FROM posts WHERE id = @id').get({ id: entry.targetId });
            const wasEdited = !before || Number(before.modified_at) > (entry.targetModified || 0) + EDIT_TOLERANCE;

            writeMeta(db, target, entry.targetId, { status: 'draft', flags: [] }, ['status', 'flags'], () => '');

            const after = db.prepare('SELECT modified_at FROM posts WHERE id = @id').get({ id: entry.targetId });
            return { ...entry, sourceDeleted: true, targetModified: wasEdited || !after ? entry.targetModified : Number(after.modified_at) };
        });
    }

    function link ({ target, post, item }) {
        return withSite(target, db => {
            const row = db.prepare('SELECT modified_at FROM posts WHERE id = @id').get({ id: item.targetId });
            return { targetId: item.targetId, title: post.title, hash: null, manual: true, meta: metaOf(post), targetModified: row ? Number(row.modified_at) : 0, linkedAt: now(), unresolved: 0 };
        });
    }

    /** Links of earlier translations that pointed to posts not translated at that time */
    function fixPendingLinks ({ target, state, refs }) {
        let fixed = 0;

        withSite(target, db => {
            const cache = ((state.tags || {})[target]) || {};
            const resolve = resolver({ db, target, state, refs: refs || { posts: new Map(), pages: new Map(), tags: new Map() }, cache });

            for (const sourceId of Object.keys(state.posts || {})) {
                const entry = entryOf(state, sourceId, target);

                if (!entry || !entry.unresolved) continue;

                const row = db.prepare('SELECT text FROM posts WHERE id = @id').get({ id: entry.targetId });

                if (!row) continue;

                const out = remapLinks(row.text, resolve, { pendingOnly: true });

                if (out.text !== row.text) {
                    // modified_at stays: the edit check compares it with the time of the last translation
                    db.prepare('UPDATE posts SET text = @text WHERE id = @id').run({ text: out.text, id: entry.targetId });
                    fixed += entry.unresolved - out.unresolved;
                }

                entry.unresolved = out.unresolved;
            }
        });

        return fixed;
    }

    return { withSite, source, plan, newTags, write, writeMetaOnly, unpublish, link, fixPendingLinks, entryOf, setEntry, readTarget };
}

module.exports = { createEngine, contentHash, metaOf, readPosts, MANAGED_FLAGS, META_KEYS };
