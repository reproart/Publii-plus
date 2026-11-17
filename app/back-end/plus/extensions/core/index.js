/**
 * Built-in "core" extension: information about the Publii Plus build.
 * Also serves as the reference example of an extension.
 */
const path = require('path');

module.exports = {
    id: 'core',
    name: 'Publii Plus core',

    register (ctx) {
        ctx.handle('info', async () => {
            const plus = require('../../index');
            const upstream = require(path.join(__dirname, '..', '..', '..', '..', 'package.json'));

            return {
                plusVersion: plus.plusVersion,
                upstreamVersion: upstream.version,
                extensions: plus.getExtensionsSummary().map(e => ({ id: e.id, name: e.name, loaded: e.loaded, error: e.error || null }))
            };
        });
    }
};
