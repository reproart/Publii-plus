const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extensions/ai-agent/format.js'), 'utf8')
    .replace(/export (function|const) /g, '$1 ') + '\nmodule.exports = { escapeHtml, formatAnswer, diffLines, TOOL_LABELS };';
const ctx = { module: { exports: {} } };
vm.runInNewContext(source, ctx);
const { formatAnswer, diffLines } = ctx.module.exports;

describe('Publii Plus: AI agent – answer formatting', () => {
    it('renders markdown (tables, lists, code) and passes a strict whitelist to the sanitizer', () => {
        const { marked } = require('marked');
        let options = null;
        const html = formatAnswer('| ID | Title |\n|---|---|\n| 5 | Test |\n\n- one\n- two\n\n**bold** `code`\nnext line', {
            parse: (t, o) => marked.parse(t, o),
            sanitize: (h, o) => { options = o; return h; }
        });

        assert.match(html, /<table>[\s\S]*<th>ID<\/th>[\s\S]*<td>5<\/td>[\s\S]*<\/table>/);
        assert.match(html, /<ul>\s*<li>one<\/li>/);
        assert.match(html, /<strong>bold<\/strong> <code>code<\/code><br>next line/, 'single line breaks are kept');
        assert.ok(!options.ALLOWED_TAGS.includes('img') && !options.ALLOWED_TAGS.includes('iframe') && !options.ALLOWED_TAGS.includes('style'));
        assert.ok(options.ALLOWED_URI_REGEXP.test('https://x.y') && !options.ALLOWED_URI_REGEXP.test('javascript:alert(1)') && !options.ALLOWED_URI_REGEXP.test('file:///etc'));
    });

    it('classifies diff lines', () => {
        const kinds = JSON.parse(JSON.stringify(diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n').map(l => l.kind)));
        assert.deepEqual(kinds, ['file', 'file', 'hunk', 'del', 'add', '']);
    });
});

describe('Publii Plus: AI agent – image helpers', () => {
    const src = fs.readFileSync(path.join(__dirname, '../extensions/ai-agent/images.js'), 'utf8')
        .replace(/export (async function|function|const) /g, '$1 ') + '\nmodule.exports = { imageFiles, fitSize, MAX_SIDE };';
    const c = { module: { exports: {} } };
    vm.runInNewContext(src, c);
    const { imageFiles, fitSize } = c.module.exports;

    it('keeps the aspect ratio and only scales down', () => {
        assert.equal(JSON.stringify(fitSize(3200, 1600)), JSON.stringify({ width: 1600, height: 800, scaled: true }));
        assert.equal(JSON.stringify(fitSize(900, 3000)), JSON.stringify({ width: 480, height: 1600, scaled: true }));
        assert.equal(JSON.stringify(fitSize(800, 600)), JSON.stringify({ width: 800, height: 600, scaled: false }));
    });

    it('takes only image files from clipboard items and file lists', () => {
        const png = { type: 'image/png', name: 'a.png' };
        const items = [
            { kind: 'string', type: 'text/plain' },
            { kind: 'file', type: 'image/png', getAsFile: () => png },
            { kind: 'file', type: 'application/pdf', getAsFile: () => ({ type: 'application/pdf' }) }
        ];
        assert.equal(imageFiles(items).length, 1);
        assert.equal(imageFiles([png, { type: 'image/svg+xml' }, { type: 'image/jpeg' }]).length, 2, 'SVG is not sent (not a raster image)');
        assert.equal(imageFiles(null).length, 0);
    });
});
