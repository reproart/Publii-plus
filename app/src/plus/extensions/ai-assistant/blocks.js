/**
 * HTML <-> Publii block editor content (JSON array of { id, type, content, config }).
 *
 * The converter works on a small node view so it can run on the browser DOM and in specs:
 *   view = { type: 'element' | 'text', tag, attr(name), inner(), outer(), text(), children() }
 * Block configs are partial: the block editor merges them with its defaults.
 */
function uid () {
    return globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : 'b-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function escapeHtml (text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function block (type, content, config = {}) {
    return { id: uid(), type, content, config };
}

function withClasses (config, node) {
    const classes = (node.attr('class') || '').trim();

    if (classes) config.advanced = { cssClasses: classes };
    return config;
}

function tableBlock (node) {
    const rows = [];
    let headers = null;

    const walk = n => {
        for (const child of n.children()) {
            if (child.tag === 'thead') {
                const tr = child.children().find(c => c.tag === 'tr');

                if (tr) headers = tr.children().filter(c => c.tag === 'th' || c.tag === 'td').map(c => c.inner().trim());
            } else if (child.tag === 'tbody' || child.tag === 'tfoot') {
                walk(child);
            } else if (child.tag === 'tr') {
                rows.push(child.children().filter(c => c.tag === 'th' || c.tag === 'td').map(c => c.inner().trim()));
            }
        }
    };

    walk(node);

    const width = Math.max(headers ? headers.length : 0, ...rows.map(r => r.length), 1);
    const pad = r => [...r, ...new Array(width - r.length).fill('')];

    return block('publii-table', {
        hasHeader: !!headers,
        hasHeaderCol: false,
        headers: pad(headers || []),
        rows: rows.length ? rows.map(pad) : [pad([])],
        colWidths: null
    });
}

function quoteBlock (node) {
    const parts = [];
    let author = '';

    for (const child of node.children()) {
        if (child.tag === 'footer' || child.tag === 'cite') author = child.text().replace(/^[—–-]\s*/, '').trim();
        else if (child.tag === 'p') parts.push(child.inner().trim());
    }

    const text = parts.length ? parts.join('<br><br>') : node.inner().trim();
    return block('publii-quote', { text, author });
}

/** Top-level nodes -> blocks. */
export function nodesToBlocks (nodes) {
    const blocks = [];

    for (const node of nodes) {
        if (node.type === 'text') {
            const text = node.text().trim();

            if (text) blocks.push(block('publii-paragraph', escapeHtml(text)));
            continue;
        }

        const tag = node.tag;
        const heading = /^h([1-6])$/.exec(tag);

        if (tag === 'p') {
            const inner = node.inner().trim();

            if (inner) blocks.push(block('publii-paragraph', inner, withClasses({}, node)));
        } else if (heading) {
            blocks.push(block('publii-header', node.inner().trim(), withClasses({ headingLevel: Number(heading[1]) }, node)));
        } else if (tag === 'ul' || tag === 'ol') {
            blocks.push(block('publii-list', node.inner().trim(), withClasses({ listType: tag }, node)));
        } else if (tag === 'blockquote') {
            blocks.push(quoteBlock(node));
        } else if (tag === 'pre') {
            const code = node.children().find(c => c.tag === 'code');
            const language = code ? ((code.attr('class') || '').match(/language-([\w-]+)/) || [])[1] : '';
            const config = language ? { language } : {};
            blocks.push(block('publii-code', (code || node).text().replace(/\n$/, ''), config));
        } else if (tag === 'hr') {
            blocks.push(block('publii-separator', false));
        } else if (tag === 'table') {
            blocks.push(tableBlock(node));
        } else if (tag === 'br') {
            continue;
        } else {
            // figures, divs with theme classes, iframes… stay as HTML
            blocks.push(block('publii-html', node.outer()));
        }
    }

    return blocks;
}

/** Browser: HTML string -> blocks (uses the DOM). */
export function htmlToBlocks (html) {
    const doc = new DOMParser().parseFromString('<body>' + String(html || '') + '</body>', 'text/html');
    return nodesToBlocks([...doc.body.childNodes].map(domView).filter(Boolean));
}

export function domView (node) {
    if (node.nodeType === 3) return { type: 'text', text: () => node.textContent, children: () => [] };
    if (node.nodeType !== 1) return null;

    return {
        type: 'element',
        tag: node.tagName.toLowerCase(),
        attr: name => node.getAttribute(name),
        inner: () => node.innerHTML,
        outer: () => node.outerHTML,
        text: () => node.textContent,
        children: () => [...node.children].map(domView)
    };
}

/** Blocks -> HTML (what the model reads as the post content). */
export function blocksToHtml (blocks) {
    const out = [];

    for (const b of Array.isArray(blocks) ? blocks : []) {
        const c = b.content;
        const config = b.config || {};

        switch (b.type) {
            case 'publii-paragraph': out.push(`<p>${c || ''}</p>`); break;
            case 'publii-header': {
                const level = config.headingLevel || 2;
                out.push(`<h${level}>${c || ''}</h${level}>`);
                break;
            }
            case 'publii-list': out.push(`<${config.listType || 'ul'}>${c || ''}</${config.listType || 'ul'}>`); break;
            case 'publii-quote': out.push(`<blockquote>${(c && c.text) || ''}${c && c.author ? ` — ${escapeHtml(c.author)}` : ''}</blockquote>`); break;
            case 'publii-code': out.push(`<pre><code>${escapeHtml(c)}</code></pre>`); break;
            case 'publii-html': out.push(String(c || '')); break;
            case 'publii-separator': out.push('<hr>'); break;
            case 'publii-table': {
                if (!c) break;
                const head = c.hasHeader ? `<tr>${(c.headers || []).map(h => `<th>${h}</th>`).join('')}</tr>` : '';
                const body = (c.rows || []).map(r => `<tr>${r.map(d => `<td>${d}</td>`).join('')}</tr>`).join('');
                out.push(`<table>${head}${body}</table>`);
                break;
            }
            case 'publii-image':
                if (c && c.image) out.push(`<img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.alt || '')}">`);
                break;
            default:
                break;
        }
    }

    return out.join('\n');
}

/** Rewritten text goes into one block: keep it inline (paragraph breaks become <br><br>). */
export function inlineHtml (html) {
    return String(html || '')
        .trim()
        .replace(/<\/p>\s*<p[^>]*>/gi, '<br><br>')
        .replace(/^<p[^>]*>|<\/p>$/gi, '');
}
