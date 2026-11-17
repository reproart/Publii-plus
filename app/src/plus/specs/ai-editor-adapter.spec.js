const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ES module -> CommonJS for the test (no bundler)
const source = fs.readFileSync(path.join(__dirname, '../extensions/ai-assistant/editor-adapter.js'), 'utf8')
    .replace(/export function /g, 'function ') + '\nmodule.exports = { createEditorAdapter, mergeTags };';
const ctx = { module: { exports: {} } };
vm.runInNewContext(source, ctx);
const { createEditorAdapter, mergeTags } = ctx.module.exports;

function fakeHugeRte () {
    const log = [];
    const editor = {
        content: '<p>Hello <strong>world</strong></p>',
        selected: '<strong>world</strong>',
        getContent () { return this.content; },
        focus () { log.push('focus'); },
        insertContent (v) { log.push(['insert', v]); },
        setContent (v) { log.push(['setContent', v]); },
        undoManager: { transact (fn) { log.push('transact'); fn(); } },
        selection: {
            getContent: () => editor.selected,
            getBookmark: () => 'BM',
            moveToBookmark: bm => log.push(['bookmark', bm]),
            setContent: v => log.push(['replaceSelection', v])
        }
    };
    return { editor, log };
}

function fakeCodeMirror () {
    const log = [];
    const cm = {
        getSelection: () => 'some **text**',
        listSelections: () => [{ from: () => ({ line: 0, ch: 5 }), to: () => ({ line: 0, ch: 18 }) }],
        replaceRange: (v, from, to) => log.push(['range', v, from, to]),
        replaceSelection: v => log.push(['replaceSelection', v]),
        focus: () => log.push('focus')
    };
    return { easymde: { codemirror: cm, value: v => log.push(['value', v]) }, log };
}

describe('Publii Plus AI: editor adapter', () => {
    it('WYSIWYG (HugeRTE): reads content/selection, writes inside undo transactions, restores the bookmark', () => {
        const { editor, log } = fakeHugeRte();
        const context = { postData: { editor: 'tinymce', text: '' }, $refs: { tinymceEditor: { editorInstance: { tinymceEditor: editor } } } };
        const a = createEditorAdapter(context);

        assert.equal(a.format, 'html');
        assert.equal(a.canInsert, true);
        assert.equal(a.getText(), '<p>Hello <strong>world</strong></p>');

        const sel = a.getSelection();
        assert.equal(sel.text, '<strong>world</strong>');
        a.replaceSelection(sel, '<em>all</em>');
        a.insert('<p>new</p>');
        a.replaceAll('<p>all new</p>');

        assert.deepEqual(log.filter(e => Array.isArray(e)), [
            ['bookmark', 'BM'], ['replaceSelection', '<em>all</em>'], ['insert', '<p>new</p>'], ['setContent', '<p>all new</p>']
        ]);
        assert.equal(log.filter(e => e === 'transact').length, 3);

        editor.selected = '   ';
        assert.equal(a.getSelection(), null, 'empty selection');
    });

    it('Markdown (EasyMDE): uses postData.text and replaces the saved range', () => {
        const { easymde, log } = fakeCodeMirror();
        const context = { postData: { editor: 'markdown', text: '# md' }, $refs: { markdownEditor: { easymde } } };
        const a = createEditorAdapter(context);

        assert.equal(a.format, 'markdown');
        assert.equal(a.getText(), '# md');

        const sel = a.getSelection();
        a.replaceSelection(sel, 'better');
        a.replaceAll('## all');

        assert.deepEqual(log[0], ['range', 'better', { line: 0, ch: 5 }, { line: 0, ch: 18 }]);
        assert.deepEqual(log[1], ['value', '## all']);
        assert.equal(context.postData.text, '## all');
    });

    it('Markdown insert separates the block from surrounding paragraphs', () => {
        // minimal CodeMirror document model
        function docCm (text, cursor) {
            const cm = {
                text,
                index (pos) { const lines = this.text.split('\n'); let i = 0; for (let l = 0; l < pos.line && l < lines.length; l++) i += lines[l].length + 1; return Math.min(this.text.length, i + (pos.line < lines.length ? pos.ch : 0)); },
                getCursor () { return cursor; },
                getRange (a, b) { return this.text.slice(this.index(a), this.index(b)); },
                replaceSelection (v) { const i = this.index(cursor); this.text = this.text.slice(0, i) + v + this.text.slice(i); },
                focus () {}
            };
            return cm;
        }

        const run = (text, cursor) => {
            const cm = docCm(text, cursor);
            createEditorAdapter({ postData: { editor: 'markdown', text }, $refs: { markdownEditor: { easymde: { codemirror: cm } } } }).insert('## New\n\nBody\n');
            return cm.text;
        };

        assert.equal(run('', { line: 0, ch: 0 }), '## New\n\nBody');
        assert.equal(run('Intro.\n\nEnd.', { line: 0, ch: 0 }), '## New\n\nBody\n\nIntro.\n\nEnd.');
        assert.equal(run('Intro.', { line: 0, ch: 6 }), 'Intro.\n\n## New\n\nBody');
        assert.equal(run('Intro.\n\nEnd.', { line: 2, ch: 0 }), 'Intro.\n\n## New\n\nBody\n\nEnd.');
    });

    it('Block editor: read-only', () => {
        const a = createEditorAdapter({ postData: { editor: 'blockeditor', text: '<p>x</p>' } });

        assert.equal(a.canInsert, false);
        assert.equal(a.getText(), '<p>x</p>');
        assert.equal(a.insert('y'), false);
        assert.equal(a.getSelection(), null);
    });

    it('editors that are not ready report failure instead of throwing', () => {
        const a = createEditorAdapter({ postData: { editor: 'tinymce', text: '<p>saved</p>' }, $refs: {} });

        assert.equal(a.getText(), '<p>saved</p>');
        assert.equal(a.insert('x'), false);
        assert.equal(a.getSelection(), null);
    });

    it('mergeTags appends only tags that are not on the post (case-insensitive)', () => {
        assert.deepEqual(Array.from(mergeTags(['Publii', 'CSS'], ['publii', 'AI', 'ai', 'Static'])), ['Publii', 'CSS', 'AI', 'Static']);
    });
});
