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
