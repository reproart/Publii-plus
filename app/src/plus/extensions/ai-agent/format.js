/**
 * Agent answers are markdown (tables, lists, headings, code). Rendering: marked -> DOMPurify.
 * The sanitizer gets a strict list: no images, frames, forms or styles (nothing loads from the network),
 * links only with http(s)/mailto – the chat opens them in the system browser.
 */
export function escapeHtml (text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const SANITIZE_OPTIONS = {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span'],
    ALLOWED_ATTR: ['href', 'title', 'align'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i
};

/** markdown -> safe HTML; parse = marked.parse, sanitize = DOMPurify.sanitize */
export function formatAnswer (text, { parse, sanitize }) {
    const html = parse(String(text || ''), { gfm: true, breaks: true, mangle: false, headerIds: false });
    return sanitize(html, SANITIZE_OPTIONS);
}

/** Lines of a unified diff with a kind for colouring. */
export function diffLines (diff) {
    return String(diff || '').split('\n').filter((l, i, all) => !(i === all.length - 1 && l === '')).map(text => ({
        text,
        kind: text.startsWith('+++') || text.startsWith('---') ? 'file' : text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : ''
    }));
}

export const TOOL_LABELS = {
    get_site_info: 'Read website info',
    list_posts: 'Listed posts',
    read_post: 'Read post',
    list_tags: 'Listed tags',
    list_theme_files: 'Listed theme files',
    read_theme_file: 'Read theme file',
    create_post: 'Create post',
    update_post: 'Update post',
    write_theme_file: 'Theme file',
    preview_site: 'Preview'
};
