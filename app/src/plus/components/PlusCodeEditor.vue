<template>
    <div class="plus-code-editor">
        <textarea ref="textarea"></textarea>
    </div>
</template>

<script>
/**
 * CodeMirror 5 editor for Publii Plus (themes, plugins, diffs).
 * v-model compatible: `value` prop + `input` event. Mode is picked from `fileName` unless `mode` is given.
 */
import CodeMirror from 'codemirror';
import '../../../node_modules/codemirror/mode/xml/xml.js';
import '../../../node_modules/codemirror/mode/htmlmixed/htmlmixed.js';
import '../../../node_modules/codemirror/mode/css/css.js';
import '../../../node_modules/codemirror/mode/javascript/javascript.js';
import '../../../node_modules/codemirror/mode/handlebars/handlebars.js';
import '../../../node_modules/codemirror/mode/markdown/markdown.js';
import '../../../node_modules/codemirror/mode/diff/diff.js';
import '../../../node_modules/codemirror/addon/search/search.js';
import '../../../node_modules/codemirror/addon/search/searchcursor.js';
import '../../../node_modules/codemirror/addon/dialog/dialog.js';
import '../../../node_modules/codemirror/addon/edit/matchbrackets.js';

export function modeForFile (fileName) {
    const ext = String(fileName || '').toLowerCase().split('.').pop();

    switch (ext) {
        case 'hbs':
        case 'handlebars': return { name: 'handlebars', base: 'text/html' };
        case 'html':
        case 'htm': return 'htmlmixed';
        case 'css': return 'css';
        case 'scss': return 'text/x-scss';
        case 'js':
        case 'mjs': return 'javascript';
        case 'json': return { name: 'javascript', json: true };
        case 'xml':
        case 'xsl':
        case 'svg': return 'xml';
        case 'md': return 'markdown';
        case 'diff':
        case 'patch': return 'diff';
        default: return 'text/plain';
    }
}

export default {
    name: 'plus-code-editor',
    props: {
        value: { type: String, default: '' },
        fileName: { type: String, default: '' },
        mode: { default: null },
        readonly: { type: Boolean, default: false }
    },
    data () {
        return { editor: null };
    },
    watch: {
        value (newValue) {
            if (this.editor && newValue !== this.editor.getValue()) {
                const scroll = this.editor.getScrollInfo();
                this.editor.setValue(newValue);
                this.editor.clearHistory();
                this.editor.scrollTo(scroll.left, scroll.top);
            }
        },
        fileName () {
            if (this.editor) this.editor.setOption('mode', this.mode || modeForFile(this.fileName));
        },
        readonly (value) {
            if (this.editor) this.editor.setOption('readOnly', value);
        }
    },
    mounted () {
        const settings = (this.$store.state.currentSite.config.advanced || {}).editors || {};
        const tab = +settings.codemirrorTabSize || 4;

        this.editor = CodeMirror.fromTextArea(this.$refs.textarea, {
            value: this.value,
            mode: this.mode || modeForFile(this.fileName),
            lineNumbers: true,
            lineWrapping: true,
            matchBrackets: true,
            readOnly: this.readonly,
            indentUnit: tab,
            tabSize: tab,
            extraKeys: {
                'Cmd-S': () => this.$emit('save'),
                'Ctrl-S': () => this.$emit('save')
            }
        });

        this.editor.setValue(this.value);
        this.editor.clearHistory();
        this.editor.on('change', () => this.$emit('input', this.editor.getValue()));
    },
    beforeDestroy () {
        if (this.editor) this.editor.toTextArea();
    },
    methods: {
        focus () {
            if (this.editor) this.editor.focus();
        },
        jumpToLine (line) {
            if (!this.editor || !line) return;

            this.editor.focus();
            this.editor.setCursor({ line: line - 1, ch: 0 });
            this.editor.scrollIntoView({ line: line - 1, ch: 0 }, 120);
        },
        refresh () {
            if (this.editor) this.editor.refresh();
        }
    }
};
</script>

<style>
@import '../../assets/vendor/css/codemirror.css';
@import '../../../node_modules/codemirror/addon/dialog/dialog.css';

.plus-code-editor,
.plus-code-editor .CodeMirror {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-sm);
    height: 100%;
}
</style>
