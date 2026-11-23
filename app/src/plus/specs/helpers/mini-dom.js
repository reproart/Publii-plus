/**
 * Tiny DOM for specs, on parse5 (a dependency of the app): enough for DOMParser + element reading.
 */
const parse5 = require('parse5');

function textOf (node) {
    if (node.nodeName === '#text') return node.value;
    return (node.childNodes || []).map(textOf).join('');
}

function wrap (node) {
    if (node.nodeName === '#text') return { nodeType: 3, textContent: node.value };
    if (!node.tagName) return { nodeType: 8 };

    return {
        nodeType: 1,
        tagName: node.tagName.toUpperCase(),
        getAttribute (name) {
            const a = node.attrs.find(x => x.name === name);
            return a ? a.value : null;
        },
        get innerHTML () { return parse5.serialize(node); },
        get outerHTML () { return parse5.serializeOuter(node); },
        get textContent () { return textOf(node); },
        get children () { return node.childNodes.filter(c => c.tagName).map(wrap); },
        get childNodes () { return node.childNodes.map(wrap); }
    };
}

class DOMParser {
    parseFromString (html) {
        const doc = parse5.parse(html);
        const htmlEl = doc.childNodes.find(n => n.tagName === 'html');
        const body = htmlEl.childNodes.find(n => n.tagName === 'body');
        return { body: wrap(body) };
    }
}

module.exports = { DOMParser };
