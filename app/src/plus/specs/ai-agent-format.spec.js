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
    it('escapes HTML from the model before adding its own markup', () => {
        const html = formatAnswer('<img src=x onerror=alert(1)> **bold** `<b>` [site](javascript:alert(1))\n- item');
        assert.doesNotMatch(html, /<img|<b>|<a /);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /<strong>bold<\/strong>/);
        assert.match(html, /<code>&lt;b&gt;<\/code>/);
        assert.match(html, /site \(javascript:alert\(1\)\)/, 'links stay plain text');
        assert.match(html, /<br>• item/);
    });

    it('classifies diff lines', () => {
        const kinds = JSON.parse(JSON.stringify(diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n').map(l => l.kind)));
        assert.deepEqual(kinds, ['file', 'file', 'hunk', 'del', 'add', '']);
    });
});
