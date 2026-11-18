/**
 * Runs in a separate process: loads a plugin's main.js like Publii's renderer does and reports
 * which hooks it registers. Plugin code never runs in the Publii Plus main process.
 */
const path = require('path');
const fs = require('fs');

function defaults (pluginDir) {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
        const out = {};

        for (const field of meta.config || []) {
            if (field && field.type !== 'separator' && field.name) out[field.name] = field.value;
        }

        return out;
    } catch (e) {
        return {};
    }
}

function check (pluginDir) {
    const registered = { insertions: [], modifiers: [], events: [] };
    const add = type => (name) => { if (!registered[type].includes(name)) registered[type].push(name); };
    const api = {
        addInsertion: add('insertions'),
        addModifier: add('modifiers'),
        addEvent: add('events'),
        removeInsertion () {},
        removeModifier () {},
        removeEvent () {},
        readFile () { return undefined; },
        createFile () { return { status: 'FILE_NOT_SAVED' }; }
    };

    const Plugin = require(path.join(pluginDir, 'main.js'));

    if (typeof Plugin !== 'function') {
        throw new Error('main.js must export a class (module.exports = MyPlugin).');
    }

    const plugin = new Plugin(api, path.basename(pluginDir), defaults(pluginDir));

    for (const method of ['addInsertions', 'addModifiers', 'addEvents']) {
        if (typeof plugin[method] === 'function') plugin[method]();
    }

    return registered;
}

if (require.main === module || process.send) {
    process.on('message', msg => {
        try {
            process.send({ ok: true, registered: check(msg.pluginDir) });
        } catch (e) {
            process.send({ ok: false, error: String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e) });
        }

        setTimeout(() => process.exit(0), 50);
    });
}

module.exports = { check };
