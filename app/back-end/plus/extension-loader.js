/**
 * Publii Plus – extension registry (main process).
 *
 * Every directory in app/back-end/plus/extensions/<id>/ with an index.js is an extension:
 *
 *   module.exports = {
 *       id: 'my-extension',               // must match the directory name
 *       name: 'My extension',
 *       register (ctx) {                   // called once, after the App instance is created
 *           ctx.handle('do-something', async (event, arg) => ...);   // IPC: 'plus:my-extension:do-something'
 *       }
 *   };
 *
 * ctx = { id, appInstance, electronApp, paths: { appDir, extensionDir }, handle (method, fn), log (...args) }
 *
 * The renderer calls handlers with this.$plus.invoke('my-extension', 'do-something', arg), which goes through
 * mainProcessAPI.invoke('plus:my-extension:do-something'); app-preload.js allows "plus:*" channels (see FORK.md).
 */
const fs = require('fs');
const path = require('path');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function channelName (extensionId, method) {
    if (!ID_PATTERN.test(extensionId) || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(method)) {
        throw new Error(`Invalid Publii Plus channel: ${extensionId} / ${method}`);
    }

    return `plus:${extensionId}:${method}`;
}

function discoverExtensions (extensionsDir) {
    if (!fs.existsSync(extensionsDir)) {
        return [];
    }

    return fs.readdirSync(extensionsDir)
        .filter(name => ID_PATTERN.test(name))
        .filter(name => fs.existsSync(path.join(extensionsDir, name, 'index.js')))
        .sort();
}

/**
 * Load and register all extensions. Errors in one extension are logged and do not stop the others.
 *
 * @returns {Array<{id, name, loaded, error?, channels}>} summary used by the "core" extension and tests
 */
function loadExtensions ({ ipcMain, appInstance, electronApp, extensionsDir = path.join(__dirname, 'extensions'), logger = console }) {
    const summary = [];

    for (const dirName of discoverExtensions(extensionsDir)) {
        const extensionDir = path.join(extensionsDir, dirName);
        const entry = { id: dirName, name: dirName, loaded: false, channels: [] };
        summary.push(entry);

        try {
            const extension = require(path.join(extensionDir, 'index.js'));

            if (!extension || extension.id !== dirName || typeof extension.register !== 'function') {
                throw new Error('index.js must export { id: "<directory name>", register (ctx) }');
            }

            entry.name = extension.name || dirName;

            const ctx = {
                id: dirName,
                appInstance,
                electronApp,
                paths: {
                    appDir: appInstance && appInstance.appDir,
                    extensionDir
                },
                handle (method, fn) {
                    const channel = channelName(dirName, method);
                    ipcMain.handle(channel, fn);
                    entry.channels.push(channel);
                    return channel;
                },
                log (...args) {
                    logger.log(`[publii-plus:${dirName}]`, ...args);
                }
            };

            extension.register(ctx);
            entry.loaded = true;
        } catch (error) {
            entry.error = error.message;
            logger.error(`[publii-plus] Extension "${dirName}" failed to load:`, error);
        }
    }

    return summary;
}

module.exports = { loadExtensions, discoverExtensions, channelName };
