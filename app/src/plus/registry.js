/**
 * Publii Plus – extension registry (renderer).
 *
 * Every app/src/plus/extensions/<id>/index.js is bundled automatically and may export:
 *
 *   export default {
 *       id: 'my-extension',                       // same id as the main-process part
 *       slots: { 'about': MyAboutComponent },     // components rendered by <plus-slot name="about">
 *   };
 *
 * Core Publii templates contain <plus-slot name="..." :context="..."> only where an extension
 * needs to appear (each such place is listed in FORK.md). Components receive `context` as a prop.
 *
 * Calling the main process: this.$plus.invoke('my-extension', 'method', ...args)
 */
import PlusSlot from './PlusSlot.vue';

export function createRegistry (extensions) {
    const slots = {};
    const ids = [];

    for (const extension of extensions) {
        if (!extension || !extension.id) continue;

        ids.push(extension.id);

        for (const [slotName, component] of Object.entries(extension.slots || {})) {
            (slots[slotName] = slots[slotName] || []).push({ extensionId: extension.id, component });
        }
    }

    return {
        ids,
        getSlot (name) {
            return slots[name] || [];
        },
        invoke (extensionId, method, ...args) {
            if (typeof window === 'undefined' || !window.mainProcessAPI) {
                return Promise.reject(new Error('Publii Plus bridge is not available'));
            }

            return window.mainProcessAPI.invoke(`plus:${extensionId}:${method}`, ...args);
        }
    };
}

function bundledExtensions () {
    const context = require.context('./extensions', true, /^\.\/[a-z0-9-]+\/index\.js$/);
    return context.keys().map(key => context(key).default);
}

export default {
    install (Vue, extensions = bundledExtensions()) {
        const registry = createRegistry(extensions);
        Vue.prototype.$plus = registry;
        Vue.component('plus-slot', PlusSlot);
    }
};
