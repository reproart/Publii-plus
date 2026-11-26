/**
 * Site check – analysis of the rendered website (no network): broken internal links and anchors, missing files,
 * images without alt, heavy images and pages, titles, descriptions, indexing, canonical, headings, mixed content.
 * External links are collected here and checked by external.js.
 */
const fs = require('fs');
const path = require('path');
const { scanHtml, listFiles } = require('./scanner');

const KB = 1024;
const LIMITS = {
    imageBytes: 500 * KB,       // a single image file
    pageBytes: 3 * 1024 * KB,   // HTML + CSS + JS + images of one page
    titleLength: 70
};

/** Pages that are not content: no SEO checks */
const SERVICE_PAGE = /(^|\/)(404|search)\.html$|^media\//;
/** Pagination: duplicates of titles/descriptions are expected */
const PAGINATION = /(^|\/)page\/\d+(\/|\.html$)/;

const SEVERITY_ORDER = { error: 0, warning: 1, notice: 2 };

function siteBase (domain) {
    const value = String(domain || '').trim();

    if (/^https?:\/\//i.test(value)) {
        const u = new URL(value.replace(/\/*$/, '/'));
        return { origin: u.origin, prefix: u.pathname, https: u.protocol === 'https:', host: u.hostname.replace(/^www\./, ''), real: true };
    }

    // relative URLs / no domain: resolve inside a placeholder origin
    return { origin: 'https://site.invalid', prefix: '/', https: false, host: '', real: false };
}

function pageUrl (base, rel) {
    return base.origin + base.prefix + rel.replace(/(^|\/)index\.html$/, '$1');
}

/** URL inside the site → path of the file in the output folder ('' when it points outside). */
function localPath (base, url) {
    if (url.origin !== base.origin && !(base.real && url.hostname.replace(/^www\./, '') === base.host && url.protocol.startsWith('http'))) return null;
    if (!url.pathname.startsWith(base.prefix) && url.pathname + '/' !== base.prefix) return null;

    let rel = url.pathname.slice(base.prefix.length);

    try {
        rel = decodeURIComponent(rel);
    } catch (e) {
        // keep it encoded
    }

    return rel;
}

function resolveFile (files, rel) {
    if (rel === '' || rel.endsWith('/')) return files.has(rel + 'index.html') ? rel + 'index.html' : null;
    if (files.has(rel)) return rel;
    if (files.has(rel + '/index.html')) return rel + '/index.html';
    return null;
}

function fileSize (outputDir, rel, cache) {
    if (!cache.has(rel)) {
        let size = 0;

        try {
            size = fs.statSync(path.join(outputDir, ...rel.split('/'))).size;
        } catch (e) {
            size = 0;
        }

        cache.set(rel, size);
    }

    return cache.get(rel);
}

const fmtSize = bytes => bytes >= 1024 * KB ? (bytes / 1024 / KB).toFixed(1) + ' MB' : Math.round(bytes / KB) + ' KB';

/**
 * @param {object} o
 * @param {string} o.outputDir     rendered website
 * @param {string} o.domain        site domain from the settings (https://example.com/blog)
 * @param {boolean} o.siteNoIndex  "noindex" for the whole website in the settings
 * @param {function} [o.itemFor]   rel path → { type, id, title } of the post/page (for "Edit")
 * @returns {{ pages: number, issues: object[], external: Map<string, object[]> }}
 */
function analyze ({ outputDir, domain, siteNoIndex = false, itemFor = () => null }) {
    const base = siteBase(domain);
    const allFiles = listFiles(outputDir);
    const files = new Set(allFiles);
    const htmlFiles = allFiles.filter(f => /\.html?$/i.test(f) && !f.startsWith('media/')).sort();
    const issues = [];
    const external = new Map();
    const sizes = new Map();
    const scanned = new Map();
    const titles = new Map();
    const descriptions = new Map();
    const heavyImages = new Map();
    const add = (severity, check, page, extra = {}) => issues.push({ severity, check, page, item: page ? itemFor(page) : null, ...extra });
    let langMissing = 0;

    const scan = rel => {
        if (!scanned.has(rel)) {
            try {
                scanned.set(rel, scanHtml(fs.readFileSync(path.join(outputDir, ...rel.split('/')), 'utf8')));
            } catch (e) {
                scanned.set(rel, null);
            }
        }

        return scanned.get(rel);
    };

    if (siteNoIndex) {
        add('error', 'noindex-site', null, { detail: 'The whole website is hidden from search engines (Site settings → SEO → "noindex" for the website).' });
    }

    // robots.txt that blocks everything
    if (files.has('robots.txt')) {
        const robots = fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8');
        const groups = robots.split(/\n(?=\s*user-agent\s*:)/i);
        const blockAll = groups.some(g => /user-agent\s*:\s*\*/i.test(g) && /^\s*disallow\s*:\s*\/\s*$/im.test(g));

        if (blockAll && !siteNoIndex) add('error', 'robots-blocked', 'robots.txt', { detail: 'robots.txt forbids all search engines to crawl the website (Disallow: /).' });
    }

    for (const rel of htmlFiles) {
        const page = scan(rel);

        if (!page) continue;

        const url = pageUrl(base, rel);
        const isService = SERVICE_PAGE.test(rel);
        const isPagination = PAGINATION.test(rel);
        const item = itemFor(rel);
        const pageAssets = new Set([rel]);

        // ---- links and files ----
        const seenOnPage = new Set();

        for (const ref of page.refs) {
            if (ref.url.indexOf('#INTERNAL_LINK#') > -1) {
                add('error', 'broken-link', rel, { target: ref.url, text: ref.text || '', detail: 'Link to a post, page or tag that no longer exists.' });
                continue;
            }

            let target;

            try {
                target = new URL(ref.url, url);
            } catch (e) {
                add('warning', 'broken-link', rel, { target: ref.url, text: ref.text || '', detail: 'Invalid address.' });
                continue;
            }

            if (!/^https?:$/.test(target.protocol)) continue;

            const local = localPath(base, target);

            if (local === null) {
                if (ref.kind === 'link' || ref.kind === 'frame' || ref.kind === 'script' || ref.kind === 'style' || ref.kind === 'image' || ref.kind === 'media') {
                    const href = target.href.split('#')[0];

                    if (base.https && target.protocol === 'http:' && ref.kind !== 'link') {
                        add('warning', 'mixed-content', rel, { target: href, detail: 'Loaded over http:// on an https:// website – browsers block or warn about it.' });
                    }

                    if (!external.has(href)) external.set(href, []);
                    if (external.get(href).length < 20) external.get(href).push({ page: rel, kind: ref.kind, text: ref.text || '' });
                }

                continue;
            }

            const file = resolveFile(files, local);
            const key = ref.kind + ' ' + local + '#' + target.hash;

            if (!file) {
                if (!seenOnPage.has(key)) {
                    const hint = /^media\/.*\/responsive\//.test(local)
                        ? 'A responsive version of an image is missing – Tools → Regenerate thumbnails (e.g. after changing the theme).'
                        : '';

                    add('error', ref.kind === 'link' ? 'broken-link' : 'missing-file', rel, { target: base.prefix + local + target.hash, text: ref.text || '', kind: ref.kind, detail: hint });
                }

                seenOnPage.add(key);
                continue;
            }

            // images are counted below (the file the browser picks from srcset, not every candidate)
            if (ref.kind !== 'link' && ref.kind !== 'image') pageAssets.add(file);

            // anchors: #section must exist on the target page
            if (target.hash && target.hash.length > 1 && /\.html?$/i.test(file) && !target.hash.startsWith('#:~:')) {
                let id = target.hash.slice(1);

                try {
                    id = decodeURIComponent(id);
                } catch (e) {
                    // keep it
                }

                const targetPage = scan(file);

                // "#top" scrolls to the top without an element (HTML standard)
                if (targetPage && !targetPage.ids.has(id) && id.toLowerCase() !== 'top' && !seenOnPage.has(key)) {
                    add('warning', 'missing-anchor', rel, { target: base.prefix + local + target.hash, text: ref.text || '', detail: `No element with id "${id}" on the target page.` });
                }

                seenOnPage.add(key);
            }
        }

        // ---- images ----
        const altMissing = new Map();

        for (const img of page.images) {
            // Publii's editors insert alt="" by default, so an empty alt on a post image means "not described";
            // theme images (assets/) with alt="" are decorative on purpose
            const contentImage = /(^|\/)media\/(posts|files)\//.test(img.src);
            const missing = img.alt === null || (contentImage && !img.alt.trim());

            if (missing && !img.hidden && img.role !== 'presentation' && img.src && !altMissing.has(img.src)) altMissing.set(img.src, img.alt === null);

            // heavy image files actually shown: src, or the largest srcset candidate up to ~1600px
            const candidates = img.srcset.length ? img.srcset.filter(c => !c.w || c.w <= 1600) : [];
            const shown = candidates.length ? candidates.sort((a, b) => b.w - a.w)[0].url : img.src;

            if (!shown) continue;

            try {
                const local = localPath(base, new URL(shown, url));
                const file = local !== null && resolveFile(files, local);

                if (file) {
                    pageAssets.add(file);
                    const size = fileSize(outputDir, file, sizes);

                    if (size > LIMITS.imageBytes) {
                        if (!heavyImages.has(file)) heavyImages.set(file, { size, pages: [] });
                        heavyImages.get(file).pages.push(rel);
                    }
                }
            } catch (e) {
                // invalid URL – reported above
            }
        }

        for (const [src, noAttribute] of altMissing) {
            add('warning', 'image-alt', rel, {
                target: src,
                detail: noAttribute
                    ? 'Image without alt text (screen readers, image search). Decorative images need alt="".'
                    : 'Image of a post without a description (empty alt).'
            });
        }

        // ---- weight ----
        const weight = [...pageAssets].reduce((sum, f) => sum + fileSize(outputDir, f, sizes), 0);

        if (weight > LIMITS.pageBytes) {
            add('warning', 'page-heavy', rel, { size: weight, detail: `The page loads ${fmtSize(weight)} (HTML, styles, scripts, images).` });
        }

        if (isService) continue;

        // ---- SEO ----
        if (!page.lang) langMissing++;

        const noindex = /\bnoindex\b|\bnone\b/.test(page.robots);

        if (noindex && !siteNoIndex) {
            if (rel === 'index.html') add('error', 'noindex-home', rel, { detail: 'The homepage is hidden from search engines (meta robots noindex).' });
            else if (item) add('notice', 'noindex-page', rel, { detail: 'Hidden from search engines (meta robots noindex) – make sure this is intended.' });
        }

        if (!page.title) {
            add('error', 'title-missing', rel, { detail: 'The page has no <title>.' });
        } else if (!isPagination && !noindex) {
            if (!titles.has(page.title)) titles.set(page.title, []);
            titles.get(page.title).push(rel);

            if (page.title.length > LIMITS.titleLength && item) {
                add('notice', 'title-long', rel, { target: page.title, detail: `Title is ${page.title.length} characters long; search engines show about ${LIMITS.titleLength}.` });
            }
        }

        if (item && !noindex) {
            if (!page.description) {
                add('notice', 'description-missing', rel, { detail: 'No meta description – search engines will pick a random piece of text.' });
            } else if (!isPagination) {
                if (!descriptions.has(page.description)) descriptions.set(page.description, []);
                descriptions.get(page.description).push(rel);
            }

            if (page.h1.length === 0) add('warning', 'h1-missing', rel, { detail: 'No H1 heading on the page.' });
            else if (page.h1.length > 1) add('notice', 'h1-multiple', rel, { target: page.h1.slice(0, 3).join(' | '), detail: `${page.h1.length} H1 headings on the page.` });
        }

        if (page.canonical && base.real) {
            try {
                const c = new URL(page.canonical, url);

                if (c.hostname.replace(/^www\./, '') !== base.host) {
                    add('warning', 'canonical-external', rel, { target: c.href, detail: 'Canonical URL points to another website – search engines will index that one instead.' });
                } else {
                    const local = localPath(base, c);

                    if (local !== null && !resolveFile(files, local)) add('error', 'canonical-broken', rel, { target: c.href, detail: 'Canonical URL points to a page that does not exist.' });
                }
            } catch (e) {
                add('warning', 'canonical-broken', rel, { target: page.canonical, detail: 'Invalid canonical URL.' });
            }
        }
    }

    for (const [title, pages] of titles) {
        if (pages.length > 1) {
            pages.forEach(p => add('warning', 'title-duplicate', p, { target: title, detail: `The same title on ${pages.length} pages.`, group: title }));
        }
    }

    for (const [description, pages] of descriptions) {
        if (pages.length > 1) {
            pages.forEach(p => add('notice', 'description-duplicate', p, { target: description.slice(0, 120), detail: `The same meta description on ${pages.length} pages.`, group: description }));
        }
    }

    for (const [file, info] of heavyImages) {
        add('warning', 'image-heavy', info.pages[0], { target: file, size: info.size, pages: info.pages.length, detail: `Image of ${fmtSize(info.size)} – compress it or use a smaller one (shown on ${info.pages.length} page(s)).` });
    }

    if (langMissing) {
        add('notice', 'lang-missing', null, { detail: `${langMissing} page(s) have no lang attribute on <html> (screen readers, translation).` });
    }

    issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.check.localeCompare(b.check) || String(a.page).localeCompare(String(b.page)));

    return { pages: htmlFiles.length, issues, external, base };
}

module.exports = { analyze, siteBase, localPath, resolveFile, fmtSize, LIMITS };
