/**
 * Safe, minimal formatting of the agent's markdown answers: HTML is escaped first,
 * then **bold**, `code`, [links] as plain text, list bullets and line breaks.
 */
export function escapeHtml (text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatAnswer (text) {
    return escapeHtml(text)
        .replace(/```[a-z]*\n([\s\S]*?)```/g, (m, code) => `<pre>${code}</pre>`)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>')
        .replace(/^\s*[-*] /gm, '• ')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
        .replace(/\n/g, '<br>');
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
