/**
 * Site check – reads the rendered website (the "output" folder that Sync uploads) and collects, for every
 * HTML page: title, meta description, robots, canonical, lang, H1s, element ids, and every reference
 * (links, images incl. srcset, CSS, JS, media, frames) with the element it comes from.
 */
const fs = require('fs');
const path = require('path');
const parse5 = require('parse5');

const SKIP_SCHEMES = /^(mailto|tel|sms|javascript|data|blob|about|callto|skype|whatsapp|viber|tg|geo):/i;

function attr (node, name) {
    const a = (node.attrs || []).find(item => item.name === name);
    return a ? a.value : null;
}

function text (node) {
    if (node.nodeName === '#text') return node.value;
    return (node.childNodes || []).map(text).join('');
}

function walk (node, visit) {
    visit(node);
    (node.childNodes || []).forEach(child => walk(child, visit));

    if (node.content) walk(node.content, visit); // <template>
}

/** "a.jpg 300w, b.jpg 600w" → [{ url, w }] */
function parseSrcset (value) {
    return String(value || '').split(/,\s+(?=\S)/).map(part => {
        const [url, size] = part.trim().split(/\s+/);
        return { url, w: parseInt(size, 10) || 0 };
    }).filter(c => c.url);
}

const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * @param {string} html
 * @returns {{ title, titleCount, description, robots, canonical, lang, h1: string[], ids: Set<string>, refs: object[], images: object[] }}
 */
function scanHtml (html) {
    const doc = parse5.parse(html);
    const page = { title: null, titleCount: 0, description: null, robots: '', canonical: null, lang: '', h1: [], ids: new Set(), refs: [], images: [] };
    const ref = (kind, url, extra = {}) => {
        const value = String(url || '').trim();

        if (!value || SKIP_SCHEMES.test(value)) return;

        page.refs.push({ kind, url: value, ...extra });
    };

    walk(doc, node => {
        const tag = node.nodeName;

        if (!node.attrs) return;

        const id = attr(node, 'id');
        const name = attr(node, 'name');

        if (id) page.ids.add(id);
        if (tag === 'a' && name) page.ids.add(name);

        switch (tag) {
            case 'html':
                page.lang = attr(node, 'lang') || '';
                break;
            case 'title':
                // the first <title> outside <svg>
                if (page.title === null) page.title = squash(text(node));
                page.titleCount++;
                break;
            case 'meta': {
                const metaName = String(attr(node, 'name') || '').toLowerCase();

                if (metaName === 'description' && page.description === null) page.description = squash(attr(node, 'content'));
                if (metaName === 'robots') page.robots += ' ' + String(attr(node, 'content') || '').toLowerCase();
                break;
            }
            case 'link': {
                const rel = String(attr(node, 'rel') || '').toLowerCase().split(/\s+/);
                const href = attr(node, 'href');

                if (rel.includes('canonical')) {
                    page.canonical = href;
                } else if (rel.includes('stylesheet')) {
                    ref('style', href);
                } else if (rel.some(r => ['icon', 'apple-touch-icon', 'manifest'].includes(r))) {
                    ref('icon', href);
                } else if (rel.includes('alternate') && attr(node, 'hreflang')) {
                    ref('link', href, { text: 'hreflang ' + attr(node, 'hreflang') });
                }
                // preconnect / dns-prefetch / preload: hints, not content
                break;
            }
            case 'h1':
                page.h1.push(squash(text(node)));
                break;
            case 'a':
            case 'area':
                ref('link', attr(node, 'href'), { text: squash(text(node)).slice(0, 80) || squash(attr(node, 'aria-label') || attr(node, 'title') || '').slice(0, 80) });
                break;
            case 'img': {
                const src = attr(node, 'src');
                const srcset = parseSrcset(attr(node, 'srcset'));

                ref('image', src);
                srcset.forEach(c => ref('image', c.url, { srcset: true }));
                page.images.push({ src: src || (srcset[0] && srcset[0].url) || '', alt: attr(node, 'alt'), srcset, role: attr(node, 'role') || '', hidden: attr(node, 'aria-hidden') === 'true' });
                break;
            }
            case 'source':
                ref('media', attr(node, 'src'));
                parseSrcset(attr(node, 'srcset')).forEach(c => ref('image', c.url, { srcset: true }));
                break;
            case 'script':
                ref('script', attr(node, 'src'));
                break;
            case 'video':
            case 'audio':
                ref('media', attr(node, 'src'));
                ref('image', attr(node, 'poster'));
                break;
            case 'iframe':
                ref('frame', attr(node, 'src'));
                break;
        }
    });

    page.robots = page.robots.trim();
    return page;
}

/** All files in the output folder, as "/"-separated paths relative to it. */
function listFiles (dir) {
    const out = [];
    const visit = (abs, rel) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const childRel = rel ? rel + '/' + entry.name : entry.name;

            if (entry.isDirectory()) visit(path.join(abs, entry.name), childRel);
            else out.push(childRel);
        }
    };

    visit(dir, '');
    return out;
}

module.exports = { scanHtml, listFiles, parseSrcset, SKIP_SCHEMES };
