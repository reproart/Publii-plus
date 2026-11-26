/**
 * Translations – Publii's internal links in a translated text point to items of the source website.
 * They are mapped to the matching items of the target website (translated post, post or page with the same slug,
 * tag with the same slug); links that cannot be mapped yet get a marker and are fixed by a later run:
 *   #INTERNAL_LINK#/post/12  →  #INTERNAL_LINK#/post/34            (mapped)
 *                            →  #INTERNAL_LINK#/post/plus-src-12   (not translated yet – a broken link until then)
 */
const LINK = /#INTERNAL_LINK#\/(post|page|tag)\/(plus-src-)?(\d+)/g;
const FILE = /#INTERNAL_LINK#\/file\/(media\/files\/[^"'\s)<>\\]+)/g;

/**
 * @param {string} text
 * @param {function} resolve  (type, sourceId) → target id or null
 * @param {object} [o]
 * @param {boolean} [o.pendingOnly]  only links with a marker (text already written to the target)
 */
function remapLinks (text, resolve, { pendingOnly = false } = {}) {
    let unresolved = 0;
    const out = String(text || '').replace(LINK, (all, type, pending, id) => {
        if (pendingOnly && !pending) return all;

        const target = resolve(type, Number(id));

        if (target) return `#INTERNAL_LINK#/${type}/${target}`;

        unresolved++;
        return `#INTERNAL_LINK#/${type}/plus-src-${id}`;
    });

    return { text: out, unresolved };
}

/** Files from the media/files folder the text links to (paths relative to input/) */
function linkedFiles (text) {
    const out = new Set();
    let m;

    FILE.lastIndex = 0;

    while ((m = FILE.exec(String(text || '')))) {
        let file = m[1].replace(/[?#].*$/, '');

        try { file = decodeURIComponent(file); } catch (e) { /* keep as is */ }

        if (!file.split('/').includes('..')) out.add(file);
    }

    return [...out];
}

module.exports = { remapLinks, linkedFiles };
