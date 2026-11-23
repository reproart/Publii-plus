/**
 * Uniform access to the three Publii editors for the AI panel.
 * `context` is the post editor component (PostEditorTinyMCE / PostEditorMarkdown / PostEditorBlockEditor).
 * The block editor gets HTML converted to blocks (blocks.js).
 *
 * adapter = {
 *   kind: 'tinymce' | 'markdown' | 'blockeditor',
 *   format: 'html' | 'markdown',
 *   canInsert: boolean,
 *   getText(), getSelection() -> { text, restore } | null,
 *   replaceSelection(saved, value), insert(value), replaceAll(value)
 * }
 * Values passed to insert/replace are in the editor's format (HTML must be sanitized by the caller).
 */
import { htmlToBlocks, blocksToHtml, inlineHtml } from './blocks.js';

export function createEditorAdapter (context) {
    const kind = context && context.postData ? context.postData.editor : '';

    if (kind === 'tinymce') {
        const editor = () => {
            const ref = context.$refs && context.$refs.tinymceEditor;
            const instance = ref && ref.editorInstance;
            return instance && instance.tinymceEditor ? instance.tinymceEditor : null;
        };

        return {
            kind,
            format: 'html',
            canInsert: true,
            getText () {
                const ed = editor();
                return ed ? ed.getContent() : context.postData.text || '';
            },
            getSelection () {
                const ed = editor();

                if (!ed) return null;

                const text = ed.selection.getContent();

                if (!text.trim()) return null;

                return { text, bookmark: ed.selection.getBookmark(2, true) };
            },
            replaceSelection (saved, value) {
                const ed = editor();

                if (!ed) return false;

                ed.focus();

                if (saved && saved.bookmark) ed.selection.moveToBookmark(saved.bookmark);

                ed.undoManager.transact(() => ed.selection.setContent(value));
                return true;
            },
            insert (value) {
                const ed = editor();

                if (!ed) return false;

                ed.focus();
                ed.undoManager.transact(() => ed.insertContent(value));
                return true;
            },
            replaceAll (value) {
                const ed = editor();

                if (!ed) return false;

                ed.undoManager.transact(() => ed.setContent(value));
                return true;
            }
        };
    }

    if (kind === 'markdown') {
        const mde = () => {
            const ref = context.$refs && context.$refs.markdownEditor;
            return ref && ref.easymde ? ref.easymde : null;
        };

        return {
            kind,
            format: 'markdown',
            canInsert: true,
            getText () {
                return context.postData.text || '';
            },
            getSelection () {
                const m = mde();

                if (!m) return null;

                const cm = m.codemirror;
                const text = cm.getSelection();

                if (!text.trim()) return null;

                const range = cm.listSelections()[0];
                return { text, from: range.from(), to: range.to() };
            },
            replaceSelection (saved, value) {
                const m = mde();

                if (!m) return false;

                if (saved && saved.from) m.codemirror.replaceRange(value, saved.from, saved.to);
                else m.codemirror.replaceSelection(value);

                return true;
            },
            insert (value) {
                const m = mde();

                if (!m) return false;

                // Inserted text is a block: separate it from the surrounding paragraphs
                const cm = m.codemirror;
                const from = cm.getCursor('from');
                const to = cm.getCursor('to');
                const before = from.line === 0 && from.ch === 0 ? '' : cm.getRange({ line: Math.max(0, from.line - 2), ch: 0 }, from);
                const after = cm.getRange(to, { line: to.line + 2, ch: 0 });
                const prefix = before === '' || /\n\n$/.test(before) ? '' : (/\n$/.test(before) ? '\n' : '\n\n');
                const suffix = after === '' || /^\n\n/.test(after) ? '' : (/^\n/.test(after) ? '\n' : '\n\n');

                cm.replaceSelection(prefix + value.trim() + suffix);
                cm.focus();
                return true;
            },
            replaceAll (value) {
                const m = mde();

                if (!m) return false;

                m.value(value);
                context.postData.text = value;
                return true;
            }
        };
    }

    if (kind === 'blockeditor') return createBlockEditorAdapter(context);

    return {
        kind: kind || 'unknown',
        format: 'html',
        canInsert: false,
        getText () {
            return (context && context.postData && context.postData.text) || '';
        },
        getSelection () {
            return null;
        },
        replaceSelection () {
            return false;
        },
        insert () {
            return false;
        },
        replaceAll () {
            return false;
        }
    };
}

/**
 * Block editor (Publii's own Vue component in the same window). Content goes through its bus events:
 * 'publii-block-editor-save' writes the blocks JSON into #post-editor, 'block-editor-set-post-text' loads new JSON.
 */
function createBlockEditorAdapter (context) {
    const bus = context.$bus;
    const root = () => document.getElementById('publii-block-editor');
    const field = () => document.getElementById('post-editor');

    function currentBlocks () {
        if (!root() || !field()) return null;

        bus.$emit('publii-block-editor-save');

        try {
            const value = field().value;
            return value ? JSON.parse(value) : [];
        } catch (e) {
            return [];
        }
    }

    function load (blocks) {
        bus.$emit('block-editor-set-post-text', JSON.stringify(blocks));
        bus.$emit('block-editor-content-updated');
        return true;
    }

    /** The selected (or last active) block, else null = end of the post */
    function activeBlockId () {
        const wrapper = root() && root().querySelector('.wrapper.is-selected, .wrapper.is-activated');
        return wrapper ? wrapper.getAttribute('data-id') : null;
    }

    return {
        kind: 'blockeditor',
        format: 'html',
        canInsert: true,
        getText () {
            const blocks = currentBlocks();
            return blocks ? blocksToHtml(blocks) : (context.postData.text || '');
        },
        getSelection () {
            const selection = window.getSelection();

            if (!selection || !selection.rangeCount || selection.isCollapsed) return null;

            const range = selection.getRangeAt(0);
            const container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
            const host = container && container.closest('[contenteditable="true"]');

            // only inside one text block of the block editor
            if (!host || !root() || !root().contains(host) || host.id === 'post-title') return null;

            const holder = document.createElement('div');
            holder.appendChild(range.cloneContents());

            if (!holder.textContent.trim()) return null;

            return { text: holder.innerHTML, range: range.cloneRange(), host };
        },
        replaceSelection (saved, value) {
            if (!saved || !saved.host || !document.body.contains(saved.host)) return false;

            const selection = window.getSelection();
            saved.host.focus();
            selection.removeAllRanges();
            selection.addRange(saved.range);
            document.execCommand('insertHTML', false, inlineHtml(value));
            bus.$emit('block-editor-content-updated');
            return true;
        },
        insert (value) {
            const blocks = currentBlocks();

            if (!blocks) return false;

            const added = htmlToBlocks(value);
            const after = activeBlockId();
            const index = after ? blocks.findIndex(b => b.id === after) : -1;
            // drop a single empty paragraph of a new post
            const base = blocks.length === 1 && blocks[0].type === 'publii-paragraph' && !String(blocks[0].content || '').trim() ? [] : blocks;

            if (index >= 0 && base.length) base.splice(index + 1, 0, ...added);
            else base.push(...added);

            return load(base);
        },
        replaceAll (value) {
            if (!root()) return false;
            return load(htmlToBlocks(value));
        }
    };
}

/** Tags to add to postData.tags: selected suggestions not already on the post (case-insensitive). */
export function mergeTags (current, suggestions) {
    const have = new Set((current || []).map(t => String(t).toLowerCase()));
    const out = (current || []).slice();

    for (const name of suggestions) {
        if (!have.has(String(name).toLowerCase())) {
            out.push(name);
            have.add(String(name).toLowerCase());
        }
    }

    return out;
}
