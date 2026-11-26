/**
 * AI alt texts – images in Publii post/page content and their alt texts, for all three editors:
 *   markdown    ![alt](#DOMAIN_NAME#file.jpg) and raw <img> tags
 *   tinymce     <img ... alt="..."> in HTML
 *   blockeditor JSON blocks: publii-image (content.alt), publii-gallery (content.images[].alt), publii-html (<img> inside)
 * Images are numbered in document order; listImages() and applyAlts() use the same traversal, so the ids match.
 */

const MD_OR_IMG = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*"|\s+'[^']*')?)\s*\)|<img\b[^>]*>/gi;
const IMG_TAG = /<img\b[^>]*>/gi;
const ATTR = name => new RegExp(`(\\s${name}\\s*=\\s*)("([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i');

function decode (s) {
    return String(s || '')
        .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function escapeAttr (s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Alt text as Publii's own block renderer can output it (it does not escape quotes) */
function cleanAlt (alt) {
    return String(alt || '').replace(/[\r\n\t]+/g, ' ').replace(/"/g, '\'').replace(/\s+/g, ' ').trim();
}

function plain (html) {
    return decode(String(html || '')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#*_`>|]+/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function attrOf (tag, name) {
    const m = tag.match(ATTR(name));
    return m ? decode(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]) : null;
}

function setAttr (tag, name, value) {
    const re = ATTR(name);

    if (re.test(tag)) return tag.replace(re, (all, prefix) => `${prefix}"${escapeAttr(value)}"`);

    return tag.replace(/^<img\b/i, `<img ${name}="${escapeAttr(value)}"`);
}

/** Text around position [start, end) without markup, for the model. */
function around (source, start, end) {
    const before = plain(source.slice(Math.max(0, start - 1200), start));
    const after = plain(source.slice(end, end + 800));

    return { before: before.slice(-400), after: after.slice(0, 250) };
}

function figcaptionAfter (source, end) {
    const m = /^\s*(?:<\/a>\s*)?<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(source.slice(end, end + 600));
    return m ? plain(m[1]) : '';
}

/**
 * Walk HTML/Markdown text. visit(image) may return a new alt (string) to change it.
 * image: { src, alt, kind, caption, context }
 */
function walkText (text, markdown, visit) {
    const re = markdown ? MD_OR_IMG : IMG_TAG;

    return text.replace(re, (...args) => {
        // replace() passes (match, ...groups, offset, string); IMG_TAG has no groups
        const all = args[0];
        const offset = args[args.length - 2];
        const [mdAlt, mdSrc, mdTitle] = markdown ? args.slice(1, 4) : [];
        const isMd = markdown && all.startsWith('!');
        const end = offset + all.length;
        const image = isMd
            ? { kind: 'content', src: mdSrc, alt: mdAlt, caption: mdTitle ? mdTitle.trim().slice(1, -1) : '' }
            : { kind: 'content', src: attrOf(all, 'src') || '', alt: attrOf(all, 'alt'), caption: figcaptionAfter(text, end) };

        image.context = around(text, offset, end);

        const next = visit(image);

        if (typeof next !== 'string') return all;
        if (isMd) return `![${cleanAlt(next).replace(/[[\]]/g, '')}](${mdSrc}${mdTitle || ''})`;
        return setAttr(all, 'alt', cleanAlt(next));
    });
}

function blockText (block) {
    if (!block || !block.content) return '';
    if (typeof block.content === 'string') return plain(block.content);
    if (typeof block.content.text === 'string') return plain(block.content.text);
    if (Array.isArray(block.content.items)) return plain(block.content.items.join(' '));
    return '';
}

function walkBlocks (json, visit) {
    let blocks;

    try {
        blocks = JSON.parse(json);
    } catch (e) {
        return json;
    }

    if (!Array.isArray(blocks)) return json;

    let changed = false;
    const contextAt = i => ({
        before: blocks.slice(Math.max(0, i - 3), i).map(blockText).join(' ').slice(-400),
        after: blocks.slice(i + 1, i + 3).map(blockText).join(' ').slice(0, 250)
    });

    blocks.forEach((block, i) => {
        if (!block || !block.content) return;

        if (block.type === 'publii-image' && block.content.image) {
            const next = visit({ kind: 'content', src: block.content.image, alt: block.content.alt || '', caption: plain(block.content.caption || ''), context: contextAt(i) });

            if (typeof next === 'string') {
                block.content.alt = cleanAlt(next);
                changed = true;
            }
        } else if (block.type === 'publii-gallery' && Array.isArray(block.content.images)) {
            block.content.images.forEach(img => {
                const next = visit({ kind: 'gallery', src: img.src || img.thumbnailSrc || '', alt: img.alt || '', caption: plain(img.caption || ''), context: contextAt(i) });

                if (typeof next === 'string') {
                    img.alt = cleanAlt(next);
                    changed = true;
                }
            });
        } else if (block.type === 'publii-html' && typeof block.content === 'string') {
            const html = walkText(block.content, false, visit);

            if (html !== block.content) {
                block.content = html;
                changed = true;
            }
        }
    });

    return changed ? JSON.stringify(blocks) : json;
}

/** Walk every content image; returns the (possibly changed) text. */
function walk (text, editor, visit) {
    const source = String(text || '');

    if (editor === 'blockeditor') return walkBlocks(source, visit);
    return walkText(source, editor === 'markdown', visit);
}

/**
 * @param {object} post   { text, editor, featured: { url, alt } | null }
 * @returns {Array<{ id, kind, src, alt, caption, context }>}  id: 'featured' or 'c<n>'
 */
function listImages (post) {
    const out = [];

    if (post.featured && post.featured.url) {
        out.push({ id: 'featured', kind: 'featured', src: post.featured.url, alt: post.featured.alt || '', caption: post.featured.caption || '', context: { before: '', after: '' } });
    }

    let n = 0;

    walk(post.text, post.editor, image => {
        out.push({ id: 'c' + (n++), ...image, alt: image.alt === null ? null : image.alt });
    });

    return out;
}

/**
 * @param {object} post   as for listImages
 * @param {object} alts   { [id]: alt }
 * @returns {{ text, featuredAlt: string|undefined, changed: number }}
 */
function applyAlts (post, alts) {
    let n = 0;
    let changed = 0;
    const text = walk(post.text, post.editor, () => {
        const id = 'c' + (n++);

        if (typeof alts[id] === 'string' && alts[id].trim()) {
            changed++;
            return alts[id];
        }

        return undefined;
    });
    let featuredAlt;

    if (typeof alts.featured === 'string' && alts.featured.trim() && post.featured && post.featured.url) {
        featuredAlt = cleanAlt(alts.featured);
        changed++;
    }

    return { text, featuredAlt, changed };
}

/** Image needs a description: no alt, or the empty alt Publii's editors insert by default. */
const needsAlt = image => image.alt === null || !String(image.alt).trim();

module.exports = { listImages, applyAlts, needsAlt, cleanAlt, plain };
