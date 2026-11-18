/**
 * Publii Plus – hook log for the plugin workshop.
 *
 * Installed into Publii's RendererPlugins (render worker process) only when the environment variable
 * PUBLII_PLUS_HOOK_LOG points to a file. Every registered plugin callback is wrapped to measure calls,
 * time, changed modifier values and errors; the summary is written when the render process exits.
 */
const fs = require('fs');
const path = require('path');

function now () {
    return Number(process.hrtime.bigint()) / 1e6;
}

function createRecorder () {
    const entries = new Map();

    return {
        record ({ plugin, type, hook, ms, changed, error }) {
            const key = `${plugin}\u0000${type}\u0000${hook}`;
            let e = entries.get(key);

            if (!e) {
                e = { plugin, type, hook, calls: 0, totalMs: 0, maxMs: 0, changed: 0, errors: 0, lastError: '' };
                entries.set(key, e);
            }

            e.calls++;
            e.totalMs += ms;
            e.maxMs = Math.max(e.maxMs, ms);

            if (changed) e.changed++;

            if (error) {
                e.errors++;
                e.lastError = String(error && error.message ? error.message : error).slice(0, 300);
            }
        },
        list () {
            return [...entries.values()]
                .map(e => ({ ...e, totalMs: Math.round(e.totalMs * 100) / 100, maxMs: Math.round(e.maxMs * 100) / 100 }))
                .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.type.localeCompare(b.type) || a.hook.localeCompare(b.hook));
        }
    };
}

/** Wrap a plugin callback; `this` and arguments are kept as Publii passes them. */
function wrapCallback (callback, { type, hook, plugin, recorder }) {
    return function publiiPlusTimedHook (...args) {
        const start = now();

        try {
            const result = callback.apply(this, args);
            // modifiers receive (rendererInstance, value, ...): count calls that returned a different value
            recorder.record({ plugin, type, hook, ms: now() - start, changed: type === 'modifiers' && result !== args[1] });
            return result;
        } catch (error) {
            recorder.record({ plugin, type, hook, ms: now() - start, error });
            throw error;
        }
    };
}

function install (RendererPlugins, { file = process.env.PUBLII_PLUS_HOOK_LOG, recorder = createRecorder(), onExit = true } = {}) {
    const proto = RendererPlugins.prototype;

    if (proto.__publiiPlusHookLog) return recorder;

    const originals = new WeakMap();
    const addOriginal = proto._add;
    const removeOriginal = proto._remove;
    let siteName = '';

    proto._add = function (type, key, callback, priority, pluginInstance) {
        if (!siteName && this.sitePath) siteName = path.basename(this.sitePath);

        const plugin = (pluginInstance && pluginInstance.name) || 'unknown';
        const wrapped = wrapCallback(callback, { type, hook: key, plugin, recorder });
        originals.set(callback, wrapped);
        return addOriginal.call(this, type, key, wrapped, priority, pluginInstance);
    };

    // plugins remove their own callbacks by reference – translate to the wrapper
    proto._remove = function (type, key, callback, priority) {
        return removeOriginal.call(this, type, key, originals.get(callback) || callback, priority);
    };

    proto.__publiiPlusHookLog = true;

    const write = () => {
        if (!file) return;

        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ site: siteName, finishedAt: new Date().toISOString(), entries: recorder.list() }, null, 2));
        } catch (e) {
            // logging must never break rendering
        }
    };

    if (onExit) process.on('exit', write);

    return { recorder, write };
}

module.exports = { install, createRecorder, wrapCallback };
