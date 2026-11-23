const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('./helpers/mini-dom');

const source = fs.readFileSync(path.join(__dirname, '../extensions/ai-assistant/blocks.js'), 'utf8')
    .replace(/export function /g, 'function ') + '\nmodule.exports = { htmlToBlocks, blocksToHtml, inlineHtml };';
const ctx = { module: { exports: {} }, DOMParser, globalThis: { crypto: require('node:crypto') } };
vm.runInNewContext(source, ctx);
const { htmlToBlocks, blocksToHtml, inlineHtml } = ctx.module.exports;
const plain = v => JSON.parse(JSON.stringify(v));
const shape = blocks => plain(blocks).map(({ id, ...rest }) => rest);

describe('Publii Plus AI: HTML <-> block editor blocks', () => {
    it('converts generated HTML into Publii blocks', () => {
        const html = [
            '<h2>Intro</h2>',
            '<p>Text with <strong>bold</strong> and <a href="https://x.y">link</a>.</p>',
            '<p class="msg msg--info">Theme style</p>',
            '<ul><li>one</li><li>two</li></ul>',
            '<ol><li>first</li></ol>',
            '<blockquote><p>Quote line</p><footer>— Author</footer></blockquote>',
            '<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>',
            '<hr>',
            '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></tbody></table>',
            '<figure class="wide"><img src="x.png"></figure>',
            '<p>   </p>',
            'loose text'
        ].join('\n');

        assert.deepEqual(shape(htmlToBlocks(html)), [
            { type: 'publii-header', content: 'Intro', config: { headingLevel: 2 } },
            { type: 'publii-paragraph', content: 'Text with <strong>bold</strong> and <a href="https://x.y">link</a>.', config: {} },
            { type: 'publii-paragraph', content: 'Theme style', config: { advanced: { cssClasses: 'msg msg--info' } } },
            { type: 'publii-list', content: '<li>one</li><li>two</li>', config: { listType: 'ul' } },
            { type: 'publii-list', content: '<li>first</li>', config: { listType: 'ol' } },
            { type: 'publii-quote', content: { text: 'Quote line', author: 'Author' }, config: {} },
            { type: 'publii-code', content: 'let a = 1 < 2;', config: { language: 'js' } },
            { type: 'publii-separator', content: false, config: {} },
            { type: 'publii-table', content: { hasHeader: true, hasHeaderCol: false, headers: ['A', 'B'], rows: [['1', '2'], ['3', '']], colWidths: null }, config: {} },
            { type: 'publii-html', content: '<figure class="wide"><img src="x.png"></figure>', config: {} },
            { type: 'publii-paragraph', content: 'loose text', config: {} }
        ]);

        const ids = htmlToBlocks('<p>a</p><p>b</p>').map(b => b.id);
        assert.equal(new Set(ids).size, 2, 'every block gets its own id');
    });

    it('turns blocks back into HTML for the model and keeps rewrites inline', () => {
        const html = blocksToHtml([
            { type: 'publii-header', content: 'T', config: { headingLevel: 3 } },
            { type: 'publii-paragraph', content: 'P', config: {} },
            { type: 'publii-code', content: '<b>', config: {} },
            { type: 'publii-quote', content: { text: 'Q', author: 'A' }, config: {} },
            { type: 'publii-image', content: { image: 'i.jpg', alt: 'Alt' }, config: {} },
            { type: 'unknown', content: 'x' }
        ]);
        assert.equal(html, '<h3>T</h3>\n<p>P</p>\n<pre><code>&lt;b&gt;</code></pre>\n<blockquote>Q — A</blockquote>\n<img src="i.jpg" alt="Alt">');
        assert.equal(blocksToHtml(null), '');
        assert.equal(inlineHtml('<p>One</p>\n<p class="x">Two</p>'), 'One<br><br>Two');
    });
});
