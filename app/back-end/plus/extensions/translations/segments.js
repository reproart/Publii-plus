/**
 * Translations – post text split into pieces the model translates, and put back together.
 * Everything that is not a translatable piece (code blocks, separators, JSON structure, block settings)
 * stays exactly as it was.
 *
 *   markdown    paragraphs / blocks separated by blank lines; fenced code blocks are kept
 *   tinymce     HTML split at top-level element boundaries (pieces up to ~4000 characters); <pre> kept
 *   blockeditor text fields of the blocks: paragraph, header, list, quote, table cells, image/gallery
 *               captions and alt texts, table of contents, HTML blocks; code, embeds, separators kept
 */

const MAX_PIECE = 4000;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const hasText = s => /[\p{L}]/u.test(String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '));

/** Markdown: [{ text, translate }] parts whose concatenation is the original text */
function markdownParts (text) {
    const parts = [];
    const lines = String(text || '').split(/(\n)/);
    let buffer = '';
    let inFence = false;
    let fence = '';

    const flush = translate => {
        if (buffer) parts.push({ text: buffer, translate: translate && hasText(buffer) });
        buffer = '';
    };

    // re-join into lines keeping the newline characters
    const rows = [];

    for (let i = 0; i < lines.length; i += 2) rows.push(lines[i] + (lines[i + 1] || ''));

    for (const row of rows) {
        const m = row.match(/^\s*(```+|~~~+)/);

        if (!inFence && m) {
            flush(true);
            inFence = true;
            fence = m[1];
            buffer = row;
            continue;
        }

        if (inFence) {
            buffer += row;

            if (row.trim().startsWith(fence)) {
                flush(false);
                inFence = false;
            }

            continue;
        }

        if (!row.trim()) {
            flush(true);
            parts.push({ text: row, translate: false });
            continue;
        }

        buffer += row;
    }

    flush(!inFence);
    return mergeSmall(parts);
}

/** HTML: split at depth 0 between elements; <pre>/<script>/<style> parts are not translated */
function htmlParts (html) {
    const source = String(html || '');
    const parts = [];
    const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
    let depth = 0;
    let start = 0;
    let rawUntil = null;
    let m;

    while ((m = re.exec(source))) {
        const tag = (m[1] || '').toLowerCase();
        const closing = m[0].startsWith('</');
        const selfClosing = /\/>$/.test(m[0]) || VOID.has(tag) || m[0].startsWith('<!--');

        if (rawUntil) {
            if (closing && tag === rawUntil) {
                rawUntil = null;
                depth--;
            } else {
                continue;
            }
        } else if (!selfClosing) {
            if (closing) depth = Math.max(0, depth - 1);
            else {
                depth++;
                if (['pre', 'script', 'style', 'code'].includes(tag) && depth === 1) rawUntil = tag;
            }
        }

        if (depth === 0) {
            const end = m.index + m[0].length;
            const piece = source.slice(start, end);
            parts.push({ text: piece, translate: !/^\s*<(pre|script|style|code)\b/i.test(piece) && hasText(piece) });
            start = end;
        }
    }

    if (start < source.length) parts.push({ text: source.slice(start), translate: hasText(source.slice(start)) });

    return mergeSmall(parts);
}

/** Join neighbouring translatable parts up to MAX_PIECE characters (fewer, more natural pieces) */
function mergeSmall (parts) {
    const out = [];

    for (const p of parts) {
        const last = out[out.length - 1];

        if (last && last.translate && (p.translate || !p.text.trim()) && last.text.length + p.text.length <= MAX_PIECE) {
            last.text += p.text;
        } else {
            out.push({ ...p });
        }
    }

    // trailing whitespace stays outside the piece the model sees
    return out.flatMap(p => {
        if (!p.translate) return [p];

        const m = p.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
        return [m[1] && { text: m[1], translate: false }, { text: m[2], translate: true }, m[3] && { text: m[3], translate: false }].filter(Boolean);
    });
}

/** Block editor: list of { get, set } accessors to text fields */
function blockFields (blocks) {
    const fields = [];
    const field = (obj, key, kind = 'html') => {
        if (obj && typeof obj[key] === 'string' && hasText(obj[key])) {
            // Publii's block renderer does not escape quotes in alt texts
            fields.push({ kind, get: () => obj[key], set: v => { obj[key] = kind === 'alt' ? String(v).replace(/"/g, '\'').replace(/\s+/g, ' ').trim() : v; } });
        }
    };

    for (const block of blocks) {
        if (!block || block.content === undefined || block.content === null) continue;

        switch (block.type) {
            case 'publii-paragraph':
            case 'publii-header':
            case 'publii-list':
            case 'publii-html':
                field(block, 'content');
                break;
            case 'publii-quote':
                field(block.content, 'text');
                field(block.content, 'author', 'text');
                break;
            case 'publii-image':
                field(block.content, 'caption');
                field(block.content, 'alt', 'alt');
                break;
            case 'publii-gallery':
                (block.content.images || []).forEach(img => {
                    field(img, 'caption');
                    field(img, 'alt', 'alt');
                });
                break;
            case 'publii-table':
                (block.content.headers || []).forEach((v, i, arr) => field(arr, i));
                (block.content.rows || []).forEach(row => (row || []).forEach((v, i, arr) => field(arr, i)));
                break;
            case 'publii-toc':
                field(block.content, 'title', 'text');
                field(block.content, 'toc');
                break;
            // publii-code, publii-embed, publii-separator, publii-readmore: nothing to translate
        }
    }

    return fields;
}

/**
 * @returns {{ pieces: string[], rebuild(translated: string[]): string }}
 */
function segment (text, editor) {
    if (editor === 'blockeditor') {
        let blocks;

        try {
            blocks = JSON.parse(text);
        } catch (e) {
            blocks = null;
        }

        if (!Array.isArray(blocks)) return { pieces: [], rebuild: () => text };

        const fields = blockFields(blocks);

        return {
            pieces: fields.map(f => f.get()),
            rebuild: translated => {
                fields.forEach((f, i) => f.set(translated[i]));
                return JSON.stringify(blocks);
            }
        };
    }

    const parts = editor === 'markdown' ? markdownParts(text) : htmlParts(text);
    const index = parts.map((p, i) => (p.translate ? i : -1)).filter(i => i > -1);

    return {
        pieces: index.map(i => parts[i].text),
        rebuild: translated => {
            const out = parts.map(p => p.text);
            index.forEach((partIndex, i) => { out[partIndex] = translated[i]; });
            return out.join('');
        }
    };
}

module.exports = { segment, markdownParts, htmlParts, hasText };
