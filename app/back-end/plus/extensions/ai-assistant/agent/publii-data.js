/**
 * Website data for the AI agent, on top of Publii's own models (main process).
 *
 * Updates are targeted: only the fields the agent changes are written, so featured images,
 * view settings and other data of a post stay untouched (Post.save() would need all of them).
 */
const fs = require('fs');
const path = require('path');

const EDITORS = ['tinymce', 'blockeditor', 'markdown'];

function parseJson (text, fallback) {
    try {
        return text ? JSON.parse(text) : fallback;
    } catch (e) {
        return fallback;
    }
}

/** "published,featured" -> { status: 'published', flags: ['featured'] } */
function splitStatus (value) {
    const parts = String(value || 'draft').split(',').map(s => s.trim()).filter(Boolean);
    return { status: parts[0] || 'draft', flags: parts.slice(1) };
}

function createPubliiData ({ app, modules = {} }) {
    const backEnd = path.join(__dirname, '..', '..', '..', '..');
    const load = name => modules[name] || require(path.join(backEnd, name));
    const Post = () => load('post.js');
    const Posts = () => load('posts.js');
    const Tags = () => load('tags.js');
    const Authors = () => load('authors.js');
    const createSlug = () => load('helpers/slug.js');

    function db (site) {
        const handle = app.getDbForSite(site);

        if (!handle) throw new Error('The website database is not available.');
        return handle;
    }

    function siteConfig (site) {
        return parseJson(fs.readFileSync(path.join(app.sitesDir, site, 'input', 'config', 'site.config.json'), 'utf8'), {});
    }

    function core (site, id) {
        const row = db(site).prepare("SELECT value FROM posts_additional_data WHERE post_id = @id AND key = '_core'").get({ id });
        return parseJson(row && row.value, {});
    }

    function tagsOf (site, id) {
        return db(site).prepare(`SELECT t.name AS name FROM tags AS t JOIN posts_tags AS pt ON pt.tag_id = t.id
            WHERE pt.post_id = @id ORDER BY t.name`).all({ id }).map(r => r.name);
    }

    function row (site, id) {
        const post = db(site).prepare("SELECT * FROM posts WHERE id = @id AND status NOT LIKE '%is-page%'").get({ id: Number(id) });

        if (!post) throw new Error(`Post ${id} does not exist.`);
        return post;
    }

    return {
        siteInfo (site) {
            const config = siteConfig(site);
            const counts = db(site).prepare("SELECT status FROM posts WHERE status NOT LIKE '%is-page%'").all()
                .reduce((acc, r) => { const s = splitStatus(r.status).status; acc[s] = (acc[s] || 0) + 1; return acc; }, {});

            return {
                site,
                name: config.displayName || config.name || site,
                domain: config.domain || '',
                language: config.language || '',
                theme: config.theme || '',
                posts: counts,
                tags: db(site).prepare('SELECT COUNT(*) AS n FROM tags').get().n
            };
        },

        listPosts (site, { query = '', status = 'any', tag = '', limit = 20, offset = 0 } = {}) {
            const rows = db(site).prepare("SELECT id, title, slug, status, created_at, modified_at FROM posts WHERE status NOT LIKE '%is-page%' ORDER BY created_at DESC").all();
            const q = String(query || '').toLowerCase();
            const tagName = String(tag || '').toLowerCase();
            const filtered = rows.filter(r => {
                const s = splitStatus(r.status);

                if (status && status !== 'any') {
                    if (['hidden', 'trashed', 'featured'].includes(status) ? !s.flags.includes(status) : s.status !== status || s.flags.includes('trashed')) return false;
                }

                if (q && !String(r.title).toLowerCase().includes(q) && !String(r.slug).toLowerCase().includes(q)) return false;
                if (tagName && !tagsOf(site, r.id).some(t => t.toLowerCase() === tagName)) return false;
                return true;
            });

            const page = filtered.slice(offset, offset + Math.min(Math.max(limit, 1), 100));

            return {
                total: filtered.length,
                posts: page.map(r => {
                    const s = splitStatus(r.status);
                    return {
                        id: r.id,
                        title: r.title,
                        slug: r.slug,
                        status: s.status,
                        flags: s.flags,
                        tags: tagsOf(site, r.id),
                        created: new Date(r.created_at).toISOString().slice(0, 10),
                        modified: new Date(r.modified_at).toISOString().slice(0, 10)
                    };
                })
            };
        },

        readPost (site, id) {
            const r = row(site, id);
            const c = core(site, r.id);
            const s = splitStatus(r.status);

            return {
                id: r.id,
                title: r.title,
                slug: r.slug,
                status: s.status,
                flags: s.flags,
                editor: EDITORS.includes(c.editor) ? c.editor : 'tinymce',
                tags: tagsOf(site, r.id),
                metaTitle: c.metaTitle || '',
                metaDescription: c.metaDesc || '',
                text: r.text || '',
                created: r.created_at,
                modified: r.modified_at
            };
        },

        listTags (site) {
            return db(site).prepare(`SELECT t.name AS name, t.slug AS slug, COUNT(pt.post_id) AS posts FROM tags AS t
                LEFT JOIN posts_tags AS pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY t.name`).all();
        },

        /**
         * New post through Publii's Post model (slug uniqueness, tags, additional data). Draft unless status is given.
         * extra: more _core fields (e.g. metaRobots, mainTag as a tag name), viewSettings: postViewSettings.
         */
        createPost (site, { title, text, editor = 'markdown', tags = [], metaTitle = '', metaDescription = '', slug = '', status = 'draft', flags = [], creationDate = null, template = '', extra = {}, viewSettings = {} }) {
            const author = db(site).prepare('SELECT id FROM authors ORDER BY id LIMIT 1').get();
            const now = Date.now();
            const created = Number.isFinite(creationDate) ? creationDate : now;
            const PostModel = Post();
            const post = new PostModel(app, {
                site,
                id: 0,
                title,
                slug: createSlug()(slug || title),
                author: author ? author.id : 1,
                status: [status === 'published' ? 'published' : 'draft', ...flags.filter(f => ['featured', 'hidden', 'excluded_homepage'].includes(f))].join(','),
                tags,
                creationDate: created,
                modificationDate: now,
                template: template || '',
                text,
                featuredImage: '',
                featuredImageFilename: '',
                featuredImageData: { alt: '', caption: '', credits: '' },
                additionalData: { metaRobots: 'index, follow', canonicalUrl: '', ...extra, metaTitle, metaDesc: metaDescription, editor },
                postViewSettings: viewSettings && typeof viewSettings === 'object' ? viewSettings : {}
            });
            const result = post.save();

            return { id: result.postID };
        },

        /** Folder of the post's images (input/media/posts/<id>) */
        mediaDir (site, id) {
            return path.join(app.sitesDir, site, 'input', 'media', 'posts', String(Number(id)));
        },

        /** Last change of a post in Publii (ms) */
        modifiedAt (site, id) {
            const r = db(site).prepare('SELECT modified_at FROM posts WHERE id = @id').get({ id: Number(id) });
            return r ? Number(r.modified_at) : null;
        },

        exists (site, id) {
            return !!db(site).prepare("SELECT id FROM posts WHERE id = @id AND status NOT LIKE '%is-page%' AND status NOT LIKE '%trashed%'").get({ id: Number(id) });
        },

        /** Featured image from a file already in the post's media folder; null removes it. */
        setFeaturedImage (site, id, image) {
            const ImageHelper = load('helpers/image.helper.js');
            const helper = new ImageHelper({
                application: app,
                site,
                id: Number(id),
                db: db(site),
                siteDir: path.join(app.sitesDir, site),
                featuredImage: image ? path.join(this.mediaDir(site, id), image.filename) : '',
                featuredImageFilename: image ? image.filename : '',
                featuredImageData: image ? { alt: image.alt || '', caption: image.caption || '', credits: image.credits || '' } : false
            });

            if (image) helper.save();
            else helper.delete();
        },

        /** Change only the given fields: title, slug, text, status, tags, metaTitle, metaDescription. */
        updatePost (site, id, fields) {
            const r = row(site, id);
            const handle = db(site);
            const set = {};

            if (typeof fields.title === 'string') set.title = fields.title;
            if (typeof fields.slug === 'string' && fields.slug) {
                // unique among posts and pages, like Publii's editor does
                const base = createSlug()(fields.slug);
                let candidate = base;

                for (let n = 2; handle.prepare('SELECT id FROM posts WHERE slug = @slug AND id != @id').get({ slug: candidate, id: r.id }); n++) {
                    candidate = `${base}-${n}`;
                }

                set.slug = candidate;
            }
            if (Number.isFinite(fields.creationDate)) set.created_at = fields.creationDate;
            if (typeof fields.text === 'string') set.text = fields.text;

            if (typeof fields.status === 'string' || Array.isArray(fields.flags)) {
                const s = splitStatus(r.status);
                const status = typeof fields.status === 'string' ? fields.status : s.status;
                // flags managed here: featured, hidden; others (e.g. trashed, excluded_homepage) are kept
                const flags = Array.isArray(fields.flags)
                    ? [...s.flags.filter(f => !['featured', 'hidden'].includes(f)), ...fields.flags.filter(f => ['featured', 'hidden'].includes(f))]
                    : s.flags;
                set.status = [status, ...flags].join(',');
            }

            const columns = Object.keys(set);

            handle.prepare(`UPDATE posts SET ${[...columns.map(c => `${c} = @${c}`), 'modified_at = @modified'].join(', ')} WHERE id = @id`)
                .run({ ...set, modified: Date.now(), id: r.id });

            if (typeof fields.metaTitle === 'string' || typeof fields.metaDescription === 'string') {
                const c = core(site, r.id);

                if (typeof fields.metaTitle === 'string') c.metaTitle = fields.metaTitle;
                if (typeof fields.metaDescription === 'string') c.metaDesc = fields.metaDescription;

                handle.prepare("DELETE FROM posts_additional_data WHERE post_id = @id AND key = '_core'").run({ id: r.id });
                handle.prepare("INSERT INTO posts_additional_data VALUES(null, @id, '_core', @value)").run({ id: r.id, value: JSON.stringify(c) });
            }

            if (Array.isArray(fields.tags)) {
                const PostModel = Post();
                const post = new PostModel(app, { site, id: r.id });
                post.tags = [...new Set(fields.tags.map(t => String(t).trim()).filter(Boolean))];
                post.saveTags();
            }

            return { id: r.id };
        },

        deletePost (site, id) {
            const PostModel = Post();
            return new PostModel(app, { site, id: Number(id) }).delete();
        },

        /** Lists Publii's store needs to refresh after a change (commit 'refreshAfterPostUpdate'). */
        storeData (site) {
            const PostsModel = Posts();
            const TagsModel = Tags();
            const AuthorsModel = Authors();
            const posts = new PostsModel(app, { site });

            return {
                posts: posts.load(),
                tags: new TagsModel(app, { site }).load(),
                postsTags: posts.loadTagsXRef(),
                postsAuthors: posts.loadAuthorsXRef(),
                authors: new AuthorsModel(app, { site }).load()
            };
        }
    };
}

module.exports = { createPubliiData, splitStatus, EDITORS };
