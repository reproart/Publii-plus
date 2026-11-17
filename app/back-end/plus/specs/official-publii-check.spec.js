const assert = require('node:assert/strict');
const { processQuery, isRunningFromOutput, isOfficialPubliiRunning, warnIfOfficialPubliiRunning } = require('../official-publii-check');

const runner = (error, stdout) => (file, args, opts, cb) => cb(error, stdout);

describe('Publii Plus: official Publii detection', () => {
    it('uses tasklist on Windows and pgrep elsewhere (exact name, so "Publii Plus" never matches)', () => {
        assert.equal(processQuery('win32').file, 'tasklist');
        assert.deepEqual(processQuery('darwin'), { file: 'pgrep', args: ['-x', 'Publii'] });
    });

    it('parses command output', () => {
        assert.equal(isRunningFromOutput('win32', '"Publii.exe","1234","Console","1","150,000 K"'), true);
        assert.equal(isRunningFromOutput('win32', 'INFO: No tasks are running which match the specified criteria.'), false);
        assert.equal(isRunningFromOutput('darwin', '4242\n'), true);
        assert.equal(isRunningFromOutput('linux', ''), false);
    });

    it('treats command errors as "not running"', async () => {
        assert.equal(await isOfficialPubliiRunning('darwin', runner(new Error('exit 1'), '')), false);
        assert.equal(await isOfficialPubliiRunning('darwin', runner(null, '77\n')), true);
    });

    it('shows a warning dialog only when Publii runs', async () => {
        const shown = [];
        const dialog = { showMessageBox: async opts => shown.push(opts) };

        assert.equal(await warnIfOfficialPubliiRunning({ dialog, platform: 'linux', run: runner(new Error('none'), '') }), false);
        assert.equal(shown.length, 0);

        assert.equal(await warnIfOfficialPubliiRunning({ dialog, platform: 'linux', run: runner(null, '1\n') }), true);
        assert.equal(shown[0].type, 'warning');
    });
});
