/**
 * Uniform access to the three Publii editors for the AI panel.
 * `context` is the post editor component (PostEditorTinyMCE / PostEditorMarkdown / PostEditorBlockEditor).
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

    // Block editor (separate app in an iframe): read-only access to the last loaded/saved HTML.
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
