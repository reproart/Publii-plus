/**
 * Publii Plus – main-process entry point. Called once from app/main.js (see FORK.md).
 */
const { loadExtensions } = require('./extension-loader');
const { warnIfOfficialPubliiRunning } = require('./official-publii-check');
const { plusVersion } = require('./version.json');

let extensionsSummary = [];

function init ({ electronApp, appInstance, ipcMain, dialog }) {
    extensionsSummary = loadExtensions({ ipcMain, appInstance, electronApp });

    if (dialog) {
        warnIfOfficialPubliiRunning({ dialog }).catch(() => {});
    }

    return extensionsSummary;
}

function getExtensionsSummary () {
    return extensionsSummary;
}

module.exports = { init, getExtensionsSummary, plusVersion };
