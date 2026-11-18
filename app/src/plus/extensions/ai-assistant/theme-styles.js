/**
 * Formatting styles that the current theme declares for the editor (theme config.json "customElements").
 * Two formats exist in Publii:
 *   - simple:   [{ label, cssClasses, selector | tag, postEditor? }]
 *   - advanced: TinyMCE/HugeRTE style_formats: [{ title, block | inline | selector, classes, items? }]
 * Returns [{ label, tag, classes }] for the AI prompt.
 */
const MAX_STYLES = 40;

function cleanClasses (value) {
    return String(value || '').split(/\s+/).filter(c => /^[A-Za-z0-9_-]+$/.test(c)).join(' ');
}

function cleanTag (value) {
    // selectors like "ol" or "ul, ol" – keep simple tag names only
    return String(value || '').split(',').map(t => t.trim().toLowerCase()).filter(t => /^[a-z][a-z0-9]*$/.test(t)).join(', ');
}

export function normalizeThemeStyles (elements, mode = 'simple') {
    if (!Array.isArray(elements)) return [];

    const out = [];
    const seen = new Set();

    const add = (label, tag, classes) => {
        const item = { label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60), tag: cleanTag(tag), classes: cleanClasses(classes) };
        const key = item.tag + '|' + item.classes;

        if (!item.tag || !item.classes || seen.has(key) || out.length >= MAX_STYLES) return;

        seen.add(key);
        out.push(item);
    };

    const walk = list => {
        for (const el of list) {
            if (!el || typeof el !== 'object') continue;

            if (mode === 'advanced') {
                if (Array.isArray(el.items)) walk(el.items);
                add(el.title, el.block || el.inline || el.selector, el.classes);
            } else {
                if (el.postEditor === false) continue;
                add(el.label, el.selector || el.tag, el.cssClasses);
            }
        }
    };

    walk(elements);
    return out;
}

/** Styles of the site currently open in Publii (from the Vuex store). */
export function currentThemeStyles (store) {
    const site = store && store.state && store.state.currentSite;
    const settings = site && site.themeSettings;

    if (!settings) return [];

    return normalizeThemeStyles(settings.customElements, settings.customElementsMode === 'advanced' ? 'advanced' : 'simple');
}
