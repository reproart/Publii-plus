const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extensions/ai-assistant/theme-styles.js'), 'utf8')
    .replace(/export function /g, 'function ') + '\nmodule.exports = { normalizeThemeStyles, currentThemeStyles };';
const ctx = { module: { exports: {} } };
vm.runInNewContext(source, ctx);
const { normalizeThemeStyles, currentThemeStyles } = ctx.module.exports;
const plain = v => JSON.parse(JSON.stringify(v));

describe('Publii Plus AI: theme styles', () => {
    it('normalizes the simple format (theme config.json customElements)', () => {
        const out = normalizeThemeStyles([
            { label: 'Info', cssClasses: 'msg msg--info', selector: 'p' },
            { label: 'Highlight', cssClasses: 'msg msg--highlight ', selector: 'p' },
            { label: 'Hidden', cssClasses: 'x', selector: 'p', postEditor: false },
            { label: 'Inline', cssClasses: 'mark', tag: 'span' },
            { label: 'Dup', cssClasses: 'msg msg--info', selector: 'p' },
            { label: 'Broken', cssClasses: '', selector: 'p' },
            null
        ]);

        assert.deepEqual(plain(out), [
            { label: 'Info', tag: 'p', classes: 'msg msg--info' },
            { label: 'Highlight', tag: 'p', classes: 'msg msg--highlight' },
            { label: 'Inline', tag: 'span', classes: 'mark' }
        ]);
    });

    it('normalizes the advanced format with nested groups', () => {
        const out = normalizeThemeStyles([
            { title: 'Boxes', items: [{ title: 'Note', block: 'aside', classes: 'post__note' }] },
            { title: 'Lead', selector: 'p', classes: 'lead' }
        ], 'advanced');

        assert.deepEqual(plain(out), [
            { label: 'Note', tag: 'aside', classes: 'post__note' },
            { label: 'Lead', tag: 'p', classes: 'lead' }
        ]);
    });

    it('reads the current site from the store and limits the list', () => {
        const many = Array.from({ length: 60 }, (_, i) => ({ label: 'S' + i, cssClasses: 'c' + i, selector: 'p' }));
        const store = { state: { currentSite: { themeSettings: { customElements: many, customElementsMode: 'simple' } } } };

        assert.equal(currentThemeStyles(store).length, 40);
        assert.equal(currentThemeStyles({ state: { currentSite: {} } }).length, 0);
    });
});
