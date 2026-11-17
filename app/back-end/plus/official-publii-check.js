/**
 * Publii Plus shares the data folder (Documents/Publii) with the official Publii app,
 * but not its single-instance lock (that lock is tied to the app name). Opening the same
 * website in both apps at once could overwrite changes, so warn when official Publii runs.
 */
const { execFile } = require('child_process');

/** Command that lists a running official Publii process on the given platform. */
function processQuery (platform) {
    if (platform === 'win32') {
        return { file: 'tasklist', args: ['/FI', 'IMAGENAME eq Publii.exe', '/NH', '/FO', 'CSV'] };
    }

    // macOS: Publii.app/Contents/MacOS/Publii, Linux: executable "Publii"
    return { file: 'pgrep', args: ['-x', 'Publii'] };
}

/** Interpret the command output. */
function isRunningFromOutput (platform, stdout) {
    const text = String(stdout || '');

    if (platform === 'win32') {
        return /"Publii\.exe"/i.test(text);
    }

    return /^\s*\d+\s*$/m.test(text);
}

function isOfficialPubliiRunning (platform = process.platform, run = execFile) {
    const { file, args } = processQuery(platform);

    return new Promise(resolve => {
        try {
            run(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
                // pgrep exits with 1 when nothing matches – treat any error as "not running"
                resolve(!error && isRunningFromOutput(platform, stdout));
            });
        } catch (e) {
            resolve(false);
        }
    });
}

async function warnIfOfficialPubliiRunning ({ dialog, platform = process.platform, run = execFile }) {
    if (!(await isOfficialPubliiRunning(platform, run))) {
        return false;
    }

    await dialog.showMessageBox({
        type: 'warning',
        buttons: ['OK'],
        title: 'Publii is running',
        message: 'The official Publii app is running.',
        detail: 'Publii Plus uses the same websites (Documents/Publii). Do not open the same website in both apps at the same time – changes made in one app can be overwritten by the other.'
    });

    return true;
}

module.exports = { processQuery, isRunningFromOutput, isOfficialPubliiRunning, warnIfOfficialPubliiRunning };
