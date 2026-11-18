/**
 * Hook names Publii's renderer really calls (verified against Publii 0.48.x; same list as publii_modified/tools/lib/hooks.js).
 */
const MODIFIERS = [
    'htmlOutput',
    'feedXmlOutput',
    'feedJsonOutput',
    'globalContext',
    'menuStructure',
    'unassignedMenuStructure',
    'contentStructure',
    'socialMetaTags',
    'jsonLD',
    'postTitle',
    'postText',
    'postExcerpt',
    'postItemData',
    'pageTitle',
    'pageText',
    'pageExcerpt',
    'pageItemData',
    'featuredImageItemData',
    'tagItemData',
    'authorItemData'
];

const INSERTIONS = [
    'publiiHead',
    'publiiFooter',
    'customHeadCode',
    'customBodyCode',
    'customFooterCode',
    'customCommentsCode',
    'customSearchInput',
    'customSearchContent',
    'customSocialSharing'
];

const EVENTS = ['beforeRender', 'afterRender'];

/** `customHTML.<key>` works for both modifiers and insertions (keys come from theme config.json renderer.customHTML). */
function isKnownHook (type, name) {
    if (name.startsWith('customHTML.') && (type === 'modifiers' || type === 'insertions')) {
        return true;
    }

    return { modifiers: MODIFIERS, insertions: INSERTIONS, events: EVENTS }[type].includes(name);
}

/** Field types rendered by Publii's plugin settings UI (src/components/ToolsPlugin.vue). */
const SPECIAL_FIELD_TYPES = [
    'separator', 'textarea', 'wysiwyg', 'radio', 'select', 'range', 'upload', 'smallupload',
    'checkbox', 'colorpicker', 'posts-dropdown', 'pages-dropdown', 'tags-dropdown', 'authors-dropdown', 'repeater'
];

/** Any other type is rendered as <input type="...">. */
const INPUT_FIELD_TYPES = ['text', 'number', 'url', 'email', 'tel', 'password', 'date', 'time', 'datetime-local', 'color', 'hidden'];

module.exports = { MODIFIERS, INSERTIONS, EVENTS, isKnownHook, SPECIAL_FIELD_TYPES, INPUT_FIELD_TYPES };
