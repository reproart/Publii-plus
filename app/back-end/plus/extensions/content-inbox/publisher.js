/**
 * Render + sync a website without the UI, with the same worker processes as Publii's Sync button
 * (workers/renderer/preview and workers/deploy/deployment). Passwords come from the keychain like in a normal
 * sync (manual deployment writes the folder/archive as usual); websites that ask for the password on every
 * sync and a first sync to an empty server need the user and are refused with a readable reason.
 */
const path = require('path');

const RENDER_TIMEOUT = 30 * 60 * 1000;
const DEPLOY_TIMEOUT = 60 * 60 * 1000;

function describe (value) {
    if (!value) return 'unknown error';
    if (typeof value === 'string') return value;

    const m = value.additionalMessage || value.message || value;

    if (typeof m === 'string') return m;
    if (m && m.translation) return m.translation + (m.translationVars ? ' ' + JSON.stringify(m.translationVars) : '');
    return JSON.stringify(m).slice(0, 300);
}

function canPublish (siteConfig) {
    const deployment = (siteConfig && siteConfig.deployment) || {};

    if (!deployment.protocol) return 'no server is configured (Server settings)';
    if (deployment.askforpassword) return 'the website asks for the password on every sync – turn that off in Server settings for automatic sync';
    return '';
}

function createPublisher ({ app, forkWorker, logsDir = () => null, saveSyncStatus = () => {}, renderTimeout = RENDER_TIMEOUT, deployTimeout = DEPLOY_TIMEOUT }) {
    function runWorker (file, logName, site, message, onMessage, timeout) {
        return new Promise((resolve, reject) => {
            const child = forkWorker(file, logsDir(site), logName);
            let done = false;
            const finish = (error, value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { child.kill(); } catch (e) { /* already gone */ }
                error ? reject(error) : resolve(value);
            };
            const timer = setTimeout(() => finish(new Error('timed out')), timeout);

            child.on('message', data => onMessage(data, finish, child));
            child.on('error', e => finish(e));
            child.on('exit', code => finish(new Error(`the worker stopped (code ${code})`)));
            child.send(message);
        });
    }

    function render (site) {
        return runWorker(path.join('renderer', 'preview'), 'rendering-deployment', site, {
            type: 'dependencies',
            appDir: app.appDir,
            sitesDir: app.sitesDir,
            siteConfig: app.sites[site],
            itemID: false,
            postData: false,
            previewMode: false,
            singlePageMode: false,
            homepageOnlyMode: false,
            tagOnlyMode: false,
            authorOnlyMode: false
        }, (data, finish) => {
            if (data.type !== 'app-rendering-results') return;
            if (data.result === true) finish(null, true);
            else finish(new Error('rendering failed: ' + describe(data.result && data.result[0])));
        }, renderTimeout);
    }

    function deploy (site) {
        return runWorker(path.join('deploy', 'deployment'), 'deployment', site, {
            type: 'dependencies',
            appDir: app.appDir,
            sitesDir: app.sitesDir,
            siteConfig: JSON.parse(JSON.stringify(app.sites[site])),
            useFtpAlt: !!(app.appConfig && app.appConfig.experimentalFeatureAppFtpAlt)
        }, (data, finish) => {
            if (data.type !== 'web-contents' && data.type !== 'sender') return;

            if (data.message === 'app-deploy-uploaded') {
                if (data.value && data.value.status === false) finish(new Error('sync failed'));
                else finish(null, { issues: !!(data.value && data.value.issues) });
            } else if (data.message === 'app-connection-error') {
                finish(new Error('connection error: ' + describe(data.value)));
            } else if (data.message === 'no-remote-files') {
                finish(new Error('the server has no files of this website yet – do the first sync in Publii'));
            }
        }, deployTimeout);
    }

    let running = null;

    return {
        canPublish: site => canPublish(app.sites && app.sites[site]),
        /** Render only (to the "output" folder, like the first step of Sync) – used by the site check */
        render,
        get busy () {
            return running;
        },
        /** Render and sync; returns { ok, issues } or throws with a readable message */
        async publish (site) {
            const reason = canPublish(app.sites && app.sites[site]);

            if (reason) throw new Error('Cannot sync automatically: ' + reason + '.');
            if (running) throw new Error(`Another publication is running (${running}).`);

            running = site;

            try {
                await render(site).catch(e => { throw new Error('Render: ' + e.message); });
                const out = await deploy(site).catch(e => { throw new Error('Sync: ' + e.message); });
                saveSyncStatus(site);
                return { ok: true, issues: out.issues };
            } finally {
                running = null;
            }
        }
    };
}

module.exports = { createPublisher, canPublish, describe };
