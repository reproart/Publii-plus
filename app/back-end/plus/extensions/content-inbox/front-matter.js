/**
 * Front matter of inbox Markdown files: a block between "---" lines at the top, in a YAML subset:
 *
 *   key: value                 strings (quoted or not), numbers, true/false, null
 *   tags: [a, "b, c"]          inline lists
 *   tags:                      block lists
 *     - a
 *   description: |             literal (|) and folded (>) multi-line text
 *     line one
 *   # comment
 *
 * Nested maps are not supported (not needed for posts). Unknown syntax is reported, not guessed.
 */
function unquote (value) {
    const v = value.trim();

    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
        return v.slice(1, -1).replace(/\\(["\\nt])/g, (m, c) => ({ n: '\n', t: '\t' }[c] || c));
    }

    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
    return null;
}

function scalar (raw) {
    const v = raw.trim();
    const quoted = unquote(v);

    if (quoted !== null) return quoted;

    const noComment = v.replace(/\s+#.*$/, '');

    if (noComment === '' || noComment === '~' || noComment === 'null') return null;
    if (/^(true|yes|on)$/i.test(noComment)) return true;
    if (/^(false|no|off)$/i.test(noComment)) return false;
    if (/^-?\d+(\.\d+)?$/.test(noComment)) return Number(noComment);
    return noComment;
}

function inlineList (raw) {
    const inner = raw.trim().slice(1, -1);
    const items = [];
    let current = '';
    let quote = '';

    for (const ch of inner) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
        } else if (ch === ',') {
            items.push(current);
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim() !== '' || items.length) items.push(current);
    return items.map(scalar).filter(v => v !== null && v !== '');
}

function parseYaml (text) {
    const data = {};
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!line.trim() || /^\s*#/.test(line)) continue;

        const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);

        if (!m) {
            errors.push(`line ${i + 1}: "${line.trim().slice(0, 40)}" is not "key: value"`);
            continue;
        }

        const key = m[1];
        const rest = m[2].trim();

        if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
            const block = [];

            while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
                block.push(lines[++i]);
            }

            const indent = Math.min(...block.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length), Infinity);
            const body = block.map(l => l.slice(Number.isFinite(indent) ? indent : 0));
            const joined = rest.startsWith('|') ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
            data[key] = joined.replace(/\n+$/, '');
        } else if (rest === '') {
            const items = [];

            while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
                items.push(scalar(lines[++i].replace(/^\s*-\s+/, '')));
            }

            data[key] = items.length ? items.filter(v => v !== null && v !== '') : null;
        } else if (rest.startsWith('[') && rest.endsWith(']')) {
            data[key] = inlineList(rest);
        } else {
            data[key] = scalar(rest);
        }
    }

    return { data, errors };
}

/** Split a Markdown file into { data, body, errors } */
function parseFrontMatter (source) {
    const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const m = /^---\n([\s\S]*?)\n(---|\.\.\.)\s*(\n|$)/.exec(text);

    if (!m) return { data: {}, body: text, errors: [] };

    const { data, errors } = parseYaml(m[1]);
    return { data, body: text.slice(m[0].length), errors };
}

module.exports = { parseFrontMatter, parseYaml };
